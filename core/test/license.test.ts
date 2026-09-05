/** T8.2 license client — offline verification, server verification, grace period, version reporting */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  checkLicense,
  getLicenseState,
  getOrCreateInstanceId,
  type LicenseEnv,
} from "../src/modules/license/service.js";
import { verifyLicense, type LicensePayload } from "../src/modules/license/format.js";
import { setupTestContext, type TestContext } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function makeKey(overrides: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    lid: "L-test",
    customer: "acme",
    plan: "standard",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30 * 86_400_000,
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = sign(null, body, privateKey);
  return `PRINA.${body.toString("base64url")}.${sig.toString("base64url")}`;
}

const DAY = 86_400_000;
let t: TestContext;

beforeAll(async () => {
  t = await setupTestContext();
});

afterAll(async () => {
  await t.cleanup();
});

const baseEnv = (over: Partial<LicenseEnv>): LicenseEnv => ({
  LICENSE_GRACE_DAYS: 14,
  ...over,
});

describe("offline (air-gapped) mode", () => {
  it("LICENSE_KEY unset → unlicensed", async () => {
    const state = await checkLicense(t.db, baseEnv({}), "0.1.0", { publicKeyPem: pubPem });
    expect(state.status).toBe("unlicensed");
    expect(await getLicenseState(t.db)).toMatchObject({ status: "unlicensed" });
  });

  it("valid key + no server configured → valid (source: offline)", async () => {
    const state = await checkLicense(t.db, baseEnv({ LICENSE_KEY: makeKey() }), "0.1.0", {
      publicKeyPem: pubPem,
    });
    expect(state).toMatchObject({ status: "valid", customer: "acme", source: "offline" });
  });

  it("tampered key → invalid", async () => {
    const state = await checkLicense(
      t.db,
      baseEnv({ LICENSE_KEY: makeKey().slice(0, -4) + "AAAA" }),
      "0.1.0",
      { publicKeyPem: pubPem },
    );
    expect(state).toMatchObject({ status: "invalid", reason: "bad_signature" });
  });

  it("expired key → expired", async () => {
    const state = await checkLicense(
      t.db,
      baseEnv({ LICENSE_KEY: makeKey({ expiresAt: Date.now() - 1000 }) }),
      "0.1.0",
      { publicKeyPem: pubPem },
    );
    expect(state.status).toBe("expired");
  });
});

describe("server verification + grace period", () => {
  const serverEnv = (key: string) =>
    baseEnv({ LICENSE_KEY: key, LICENSE_SERVER_URL: "http://license.test" });

  it("server valid:true → valid (source: server) + reporting body carries instanceId and version", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ valid: true, serverTime: Date.now() }), { status: 200 });
    }) as typeof fetch;

    const state = await checkLicense(t.db, serverEnv(makeKey()), "0.1.7", {
      publicKeyPem: pubPem,
      fetchImpl,
    });
    expect(state).toMatchObject({ status: "valid", source: "server" });
    expect(state.lastServerOkAt).not.toBeNull();
    expect(captured!.url).toBe("http://license.test/v1/validate");
    expect(captured!.body.version).toBe("0.1.7");
    expect(captured!.body.instanceId).toBe(await getOrCreateInstanceId(t.db));
  });

  it("instanceId is immutable", async () => {
    const a = await getOrCreateInstanceId(t.db);
    const b = await getOrCreateInstanceId(t.db);
    expect(a).toBe(b);
  });

  it("updateAvailable when the release feed has a newer patch (T8.3 banner)", async () => {
    const fetchImpl = (async (url: URL | string) => {
      if (String(url).includes("/v1/releases/latest")) {
        return new Response(
          JSON.stringify({ release: { version: "0.1.9", critical: true, channel: "0.1" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as typeof fetch;
    const state = await checkLicense(t.db, serverEnv(makeKey()), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl,
    });
    expect(state).toMatchObject({
      status: "valid",
      updateAvailable: true,
      latestPatch: "0.1.9",
      latestCritical: true,
    });
  });

  it("updateAvailable=false when the feed matches the current version", async () => {
    const fetchImpl = (async (url: URL | string) => {
      if (String(url).includes("/v1/releases/latest")) {
        return new Response(JSON.stringify({ release: { version: "0.1.0", critical: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as typeof fetch;
    const state = await checkLicense(t.db, serverEnv(makeKey()), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl,
    });
    expect(state.updateAvailable).toBe(false);
  });

  it("server says revoked → immediately revoked (no grace applied)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ valid: false, reason: "revoked" }), { status: 200 })) as typeof fetch;
    const state = await checkLicense(t.db, serverEnv(makeKey()), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl,
    });
    expect(state).toMatchObject({ status: "revoked", reason: "revoked" });
  });

  it("server unreachable: within grace → grace, past grace → grace_expired, valid again on recovery", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const key = makeKey();
    const t0 = Date.now();

    // Record one success first so we are not carrying a no-success-history state from the previous test
    const okFetch = (async () =>
      new Response(JSON.stringify({ valid: true }), { status: 200 })) as typeof fetch;
    await checkLicense(t.db, serverEnv(key), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl: okFetch,
      now: t0,
    });

    // failure on day 3 after success → grace
    const day3 = await checkLicense(t.db, serverEnv(key), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl: failing,
      now: t0 + 3 * DAY,
    });
    expect(day3.status).toBe("grace");

    // failure on day 15 after success → past the 14-day grace period
    const day15 = await checkLicense(t.db, serverEnv(key), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl: failing,
      now: t0 + 15 * DAY,
    });
    expect(day15.status).toBe("grace_expired");

    // server recovers → immediately valid
    const recovered = await checkLicense(t.db, serverEnv(key), "0.1.0", {
      publicKeyPem: pubPem,
      fetchImpl: okFetch,
      now: t0 + 16 * DAY,
    });
    expect(recovered.status).toBe("valid");
  });
});

describe("format copy sync guard", () => {
  it("core verifyLicense validates the server-issued format", () => {
    const key = makeKey();
    const r = verifyLicense(key, pubPem);
    expect(r.ok).toBe(true);
  });
});
