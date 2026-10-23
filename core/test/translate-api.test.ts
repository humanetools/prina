/** Entry AI translation over the REST API with access tokens (28-IMPL) */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiGrantItem, ApiGrantLevel, McpPlane, type ApiGrant } from "@prina/shared";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { contentTypeCreate } from "../src/modules/content-type/commands.js";
import { entryCreate, entryGet } from "../src/modules/entry/commands.js";
import { localeCreate } from "../src/modules/locale/commands.js";
import { mcpTokenCreate } from "../src/modules/mcp/tokens.js";
import { setupTestContext, type TestContext } from "./helpers.js";

let t: TestContext;
let app: FastifyInstance;
let editTok = "";
let readTok = "";
let otherTypeTok = "";
let sourceId = "";
let sourceLocale = "";

const H = (token: string) => ({ authorization: `Bearer ${token}` });
const translate = (token: string, id: string, payload: Record<string, unknown>, typeUid = "ta_page") =>
  app.inject({ method: "POST", url: `/api/content/${typeUid}/${id}/translate`, headers: H(token), payload });

/** LLM stub: echoes every segment back with a [xx] prefix */
const stubLlm = (prefix = "[en]") => {
  t.services.llm = async ({ user }) => {
    const segments = JSON.parse(user) as Record<string, string>;
    return JSON.stringify(Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, `${prefix} ${v}`])));
  };
};

beforeAll(async () => {
  t = await setupTestContext();
  const { db } = createDb(process.env.TEST_DATABASE_URL!);
  app = buildApp({ env: { LOG_LEVEL: "error", NODE_ENV: "test", ADMIN_DIST_PATH: undefined, S3_REGION: "us-east-1" }, db, services: t.services });
  const issue = async (name: string, grants: ApiGrant[]) => (await mcpTokenCreate.run({ name, plane: McpPlane.Management, grants }, t.ctx)).token;
  editTok = await issue("ta-edit", [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit }]);
  readTok = await issue("ta-read", [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Read }]);
  otherTypeTok = await issue("ta-other-type", [{ item: ApiGrantItem.Entries, level: ApiGrantLevel.Edit, types: ["ta_other"] }]);

  for (const code of ["en", "ja", "de"]) await localeCreate.run({ code, name: code }, t.ctx);
  const def = { displayField: "title", fields: [{ name: "title", type: "text", required: true }, { name: "summary", type: "text" }] };
  await contentTypeCreate.run({ uid: "ta_page", name: "Page", definition: def }, t.ctx);
  await contentTypeCreate.run({ uid: "ta_other", name: "Other", definition: def }, t.ctx);
  const { entry } = await entryCreate.run({ typeUid: "ta_page", values: { title: "머신 비전 카메라", summary: "고속 검사용" } }, t.ctx);
  sourceId = entry.id;
  sourceLocale = entry.locale;
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe("POST /api/content/:typeUid/:id/translate", () => {
  it("edit token: creates a draft sibling in the target locale with provenance; the source is untouched", async () => {
    stubLlm();
    const res = await translate(editTok, sourceId, { targetLocale: "en" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.entry).toMatchObject({ locale: "en", status: "draft" });
    expect(body.entry.values).toEqual({ title: "[en] 머신 비전 카메라", summary: "[en] 고속 검사용" });
    expect(body.entry.aiDraft).toMatchObject({ kind: "translation", sourceEntryId: sourceId, sourceLocale });
    expect(body.segmentCount).toBe(2);
    expect(body.issues).toEqual([]);
    const source = await entryGet.run({ typeUid: "ta_page", id: sourceId }, t.ctx);
    expect(source.entry.documentId).toBe(body.entry.documentId);
    expect(source.entry.values).toMatchObject({ title: "머신 비전 카메라" });
  });

  it("`fields` narrows what is translated — the rest is carried over as is", async () => {
    stubLlm("[ja]");
    const res = await translate(editTok, sourceId, { targetLocale: "ja", fields: ["title"] });
    expect(res.statusCode).toBe(201);
    expect(res.json().entry.values).toEqual({ title: "[ja] 머신 비전 카메라", summary: "고속 검사용" });
  });

  it("never overwrites an existing locale (409) and validates the target (422)", async () => {
    stubLlm();
    expect((await translate(editTok, sourceId, { targetLocale: "en" })).statusCode).toBe(409);
    expect((await translate(editTok, sourceId, { targetLocale: "xx-none" })).statusCode).toBe(422);
    expect((await translate(editTok, sourceId, { targetLocale: sourceLocale })).statusCode).toBe(422);
    expect((await translate(editTok, sourceId, {})).statusCode).toBe(422);
    expect((await translate(editTok, "00000000-0000-4000-8000-000000000000", { targetLocale: "de" })).statusCode).toBe(404);
  });

  it("needs the entries grant at edit level, for that content type", async () => {
    stubLlm();
    const read = await translate(readTok, sourceId, { targetLocale: "de" });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toMatchObject({ code: "SCOPE_DENIED", details: { item: "entries", required: "edit" } });
    const otherType = await translate(otherTypeTok, sourceId, { targetLocale: "de" });
    expect(otherType.statusCode).toBe(403);
    expect(otherType.json().error.code).toBe("SCOPE_DENIED");
    expect((await app.inject({ method: "POST", url: `/api/content/ta_page/${sourceId}/translate`, payload: { targetLocale: "de" } })).statusCode).toBe(401);
  });

  it("tells a provider failure (502) from a missing AI setup (400) — nothing is created either way", async () => {
    t.services.llm = async () => { throw new Error("overloaded_error: the model is busy"); };
    const failed = await translate(editTok, sourceId, { targetLocale: "de" });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatchObject({ code: "AI_PROVIDER_ERROR" });
    expect(failed.json().error.message).toContain("the model is busy");

    delete t.services.llm;
    const unset = await translate(editTok, sourceId, { targetLocale: "de" });
    expect(unset.statusCode).toBe(400);
    expect(unset.json().error.code).toBe("AI_NOT_CONFIGURED");

    // the failed attempts left no `de` entry behind — the retry succeeds
    stubLlm("[de]");
    expect((await translate(editTok, sourceId, { targetLocale: "de" })).statusCode).toBe(201);
  });

  it("is documented with its access requirement and AI error responses", async () => {
    const spec = (await app.inject({ method: "GET", url: "/openapi.json", headers: { "x-prina-workspace": t.workspaceSlug, "x-prina-actor": `human:${t.userId}` } })).json();
    const op = spec.paths["/api/content/{typeUid}/{id}/translate"].post;
    expect(op["x-prina-access"]).toMatchObject({ grant: { item: "entries", level: "edit" } });
    expect(Object.keys(op.requestBody.content["application/json"].schema.properties).sort()).toEqual(["fields", "includeSeo", "targetLocale"]);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["201", "400", "403", "409", "422", "502"]));
  });
});
