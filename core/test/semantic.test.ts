/**
 * T9.3 semantic search — pgvector gate, publish queueing, worker, hybrid fusion.
 * In environments without pgvector (CI) only the gate test remains; vector paths are skipped
 * (locally, install via scripts/dev-pgvector.sh).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryUpdate } from "../src/modules/entry/commands.js";
import { aiSettingsSet } from "../src/modules/ai/commands.js";
import {
  embedWorkerTick,
  ensureVectorCapability,
  resetVectorCapability,
} from "../src/modules/delivery/semantic.js";
import { searchPublished } from "../src/modules/delivery/search.js";
import { publishEntry,
  setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let stub: Server;
let stubUrl: string;
let hasVector = false;
let cameraId: string;
let lampId: string;

/** Deterministic stub embedding — hashes character bigrams into 128 buckets (too few buckets flips rankings via collisions) */
function stubEmbed(text: string): number[] {
  const v = new Array<number>(128).fill(0);
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i) * 31 + text.charCodeAt(i + 1);
    v[Math.abs(code) % 128]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function publish(typeUid: string, id: string) {
  await publishEntry(t.ctx, typeUid, id);
}

beforeAll(async () => {
  t = await setupTestContext();
  resetVectorCapability();
  hasVector = await ensureVectorCapability(t.ctx.db);

  // OpenAI-compatible embedding stub server
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: input.map((text) => ({ embedding: stubEmbed(text) })) }));
    });
  });
  await new Promise<void>((ok) => stub.listen(0, "127.0.0.1", ok));
  const addr = stub.address() as { port: number };
  stubUrl = `http://127.0.0.1:${addr.port}/embeddings`;

  await aiSettingsSet.run(
    {
      apiKey: null,
      embeddings: { provider: "custom", apiKey: "stub-key", model: "stub-1", baseUrl: stubUrl },
    },
    t.ctx,
  );

  await contentTypeCreate.run(
    {
      uid: "kb-doc",
      name: "KB Doc",
      definition: {
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body", type: "text" },
        ],
        displayField: "title",
      },
    },
    t.ctx,
  );
  const camera = await entryCreate.run(
    { typeUid: "kb-doc", values: { title: "야외 방수 카메라", body: "IP68 방수 등급의 야외 감시 카메라" } },
    t.ctx,
  );
  cameraId = camera.entry.id;
  const lamp = await entryCreate.run(
    { typeUid: "kb-doc", values: { title: "실내 조명 스탠드", body: "따뜻한 색온도의 거실 조명" } },
    t.ctx,
  );
  lampId = lamp.entry.id;
  // document kept as draft — must not appear in search
  await entryCreate.run(
    { typeUid: "kb-doc", values: { title: "방수 손목시계", body: "draft 문서" } },
    t.ctx,
  );
  await publish("kb-doc", cameraId);
  await publish("kb-doc", lampId);
});
afterAll(async () => {
  await new Promise<void>((ok) => stub.close(() => ok()));
  await t.cleanup();
});

describe("semantic search (T9.3)", () => {
  it("pgvector capability gate is detected (vector paths skip when absent)", () => {
    expect(typeof hasVector).toBe("boolean");
  });

  it("FTS always works regardless of embeddings", async () => {
    const hits = await searchPublished(t.ctx.db, t.ctx.workspaceId, "조명");
    expect(hits.some((h) => h.id === lampId)).toBe(true);
  });

  it("publish queueing → worker fills in embeddings", async (tc) => {
    if (!hasVector) return tc.skip();
    const r1 = await embedWorkerTick(t.ctx.db);
    expect(r1.skipped).toBeNull();
    expect(r1.processed).toBeGreaterThanOrEqual(2); // camera + lamp (draft excluded)
    // The worker drains the WHOLE test DB and files run in parallel, so other files'
    // publishes can land between ticks — drain with a bounded loop instead of one tick
    // (this flaked full runs twice on 2026-08-24 with processed=6 from a neighbor file)
    let drained = false;
    for (let i = 0; i < 10 && !drained; i++) {
      drained = (await embedWorkerTick(t.ctx.db)).processed === 0;
    }
    expect(drained).toBe(true);
  });

  it("semantic fusion — a meaning-based query ranks the right document on top", async (tc) => {
    if (!hasVector) return tc.skip();
    const hits = await searchPublished(t.ctx.db, t.ctx.workspaceId, "방수되는 야외용 카메라");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(cameraId);
    expect(["semantic", "both", "fts"]).toContain(hits[0]!.matchedBy);
    // the draft document appears via no path
    expect(hits.every((h) => h.title !== "방수 손목시계")).toBe(true);
  });

  it("edit while published → re-queue → re-embed", async (tc) => {
    if (!hasVector) return tc.skip();
    await entryUpdate.run(
      { typeUid: "kb-doc", id: lampId, values: { body: "무드등 겸용 스탠드" } },
      t.ctx,
    );
    const r = await embedWorkerTick(t.ctx.db);
    expect(r.processed).toBe(1);
  });

  it("falls back to FTS when embedding config is removed", async () => {
    await aiSettingsSet.run({ apiKey: null, embeddings: null }, t.ctx);
    const hits = await searchPublished(t.ctx.db, t.ctx.workspaceId, "카메라");
    expect(hits.some((h) => h.id === cameraId)).toBe(true);
    expect(hits.every((h) => h.matchedBy === "fts")).toBe(true);
    // restore (avoid affecting other tests)
    await aiSettingsSet.run(
      {
        apiKey: null,
        embeddings: { provider: "custom", apiKey: "stub-key", model: "stub-1", baseUrl: stubUrl },
      },
      t.ctx,
    );
  });
});
