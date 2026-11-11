/**
 * License status determination (T8.2) — offline verification + optional server check + grace period.
 *
 * Design decision (§3, "never hard-block a customer on server outage"):
 * - No feature is hard-blocked in any state. Status is only recorded in
 *   instance_settings['license'] and shown in admin (blocking is a contract/sales matter).
 * - LICENSE_SERVER_URL unset = air-gapped mode: offline signature/expiry checks only.
 * - Server unreachable means grace: within LICENSE_GRACE_DAYS of the last success
 *   (or first failure if none) it is "grace", beyond that "grace_expired". An explicit
 *   invalid verdict from the server is applied immediately.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { instanceSettings } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { verifyLicense } from "./format.js";
import { LICENSE_PUBLIC_KEY_PEM } from "./public-key.js";

export type LicenseStatus =
  | "unlicensed" // LICENSE_KEY unset (dev/evaluation)
  | "valid"
  | "expired"
  | "revoked"
  | "invalid" // bad signature, no issuance record, etc.
  | "grace" // server unreachable, within grace period
  | "grace_expired"; // server unreachable beyond grace period

export interface LicenseState {
  status: LicenseStatus;
  reason: string | null;
  customer: string | null;
  plan: string | null;
  expiresAt: number | null;
  /** Last server validation attempt/success (null in offline mode) */
  lastCheckedAt: number | null;
  lastServerOkAt: number | null;
  /** offline = air-gapped (no server configured), server = reflects server validation */
  source: "offline" | "server";
  /** Release feed (T8.3) — for the unpatched banner. null/false when feed unreachable */
  latestPatch: string | null;
  latestCritical: boolean;
  updateAvailable: boolean;
}

export interface LicenseEnv {
  LICENSE_KEY?: string;
  LICENSE_SERVER_URL?: string;
  LICENSE_GRACE_DAYS: number;
}

const SETTINGS_KEY = "license";

interface PersistedLicense {
  state?: LicenseState;
  instanceId?: string;
  /** Grace baseline when the server has been failing without any prior success */
  firstServerFailAt?: number;
}

async function readPersisted(db: Db): Promise<PersistedLicense> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SETTINGS_KEY))
    .limit(1);
  return (row?.value as PersistedLicense | undefined) ?? {};
}

async function writePersisted(db: Db, value: PersistedLicense): Promise<void> {
  const record = value as Record<string, unknown>;
  await db
    .insert(instanceSettings)
    .values({ key: SETTINGS_KEY, value: record })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: record } });
}

/** Install identifier — created on first access, immutable afterward (version reporting key) */
export async function getOrCreateInstanceId(db: Db): Promise<string> {
  const persisted = await readPersisted(db);
  if (persisted.instanceId) return persisted.instanceId;
  const instanceId = randomUUID();
  await writePersisted(db, { ...persisted, instanceId });
  return instanceId;
}

export async function getLicenseState(db: Db): Promise<LicenseState | null> {
  return (await readPersisted(db)).state ?? null;
}

interface ServerValidateResponse {
  valid: boolean;
  reason?: string;
  license?: { customer: string; plan: string; expiresAt: number };
}

/**
 * Run one license check + persist the state. Called periodically by the worker, plus once at startup.
 * The publicKeyPem parameter is for tests — production uses the embedded key.
 */
export async function checkLicense(
  db: Db,
  env: LicenseEnv,
  coreVersion: string,
  opts: { publicKeyPem?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<LicenseState> {
  const now = opts.now ?? Date.now();
  const publicKey = opts.publicKeyPem ?? LICENSE_PUBLIC_KEY_PEM;
  const doFetch = opts.fetchImpl ?? fetch;
  const persisted = await readPersisted(db);
  const prev = persisted.state ?? null;

  // Check release feed (T8.3 unpatched banner) — independent of validation: feed failure never affects status
  let latestPatch: string | null = null;
  let latestCritical = false;
  if (env.LICENSE_SERVER_URL) {
    try {
      const channel = coreVersion.split(".").slice(0, 2).join(".");
      const res = await doFetch(
        new URL(`/v1/releases/latest?channel=${channel}`, env.LICENSE_SERVER_URL),
        { signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          release?: { version: string; critical: boolean } | null;
        };
        if (body.release) {
          latestPatch = body.release.version;
          latestCritical = body.release.critical;
        }
      }
    } catch {
      /* feed unreachable — no banner */
    }
  }
  const patchOf = (v: string) => Number(v.split(".")[2] ?? 0);
  const updateAvailable = latestPatch !== null && patchOf(latestPatch) > patchOf(coreVersion);

  const finish = async (
    state: Omit<
      LicenseState,
      "lastCheckedAt" | "lastServerOkAt" | "source" | "latestPatch" | "latestCritical" | "updateAvailable"
    > &
      Partial<Pick<LicenseState, "lastCheckedAt" | "lastServerOkAt" | "source">>,
    extra: Partial<PersistedLicense> = {},
  ): Promise<LicenseState> => {
    const full: LicenseState = {
      lastCheckedAt: state.lastCheckedAt ?? null,
      lastServerOkAt: state.lastServerOkAt ?? prev?.lastServerOkAt ?? null,
      source: state.source ?? "offline",
      ...state,
      latestPatch,
      latestCritical,
      updateAvailable,
    };
    await writePersisted(db, { ...persisted, ...extra, state: full });
    return full;
  };

  // 1) No key configured — dev/evaluation install
  if (!env.LICENSE_KEY) {
    return finish({ status: "unlicensed", reason: null, customer: null, plan: null, expiresAt: null });
  }

  // 2) Offline signature verification — always runs first, regardless of the server
  const verified = verifyLicense(env.LICENSE_KEY, publicKey);
  if (!verified.ok) {
    return finish({ status: "invalid", reason: verified.reason, customer: null, plan: null, expiresAt: null });
  }
  const { payload } = verified;
  const base = { customer: payload.customer, plan: payload.plan, expiresAt: payload.expiresAt };

  if (now > payload.expiresAt) {
    return finish({ status: "expired", reason: "expired", ...base });
  }

  // 3) Air-gapped mode — finish without server validation
  if (!env.LICENSE_SERVER_URL) {
    return finish({ status: "valid", reason: null, ...base, source: "offline" });
  }

  // 4) Server validation + version reporting
  try {
    // Also reflect into local persisted — so finish()'s write does not clobber a new instanceId
    if (!persisted.instanceId) persisted.instanceId = await getOrCreateInstanceId(db);
    const instanceId = persisted.instanceId;
    const res = await doFetch(new URL("/v1/validate", env.LICENSE_SERVER_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: env.LICENSE_KEY, instanceId, version: coreVersion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`license server HTTP ${res.status}`);
    const body = (await res.json()) as ServerValidateResponse;

    if (body.valid) {
      return finish(
        { status: "valid", reason: null, ...base, lastCheckedAt: now, lastServerOkAt: now, source: "server" },
        { firstServerFailAt: undefined },
      );
    }
    // Server explicitly ruled invalid — apply immediately, no grace
    const status: LicenseStatus =
      body.reason === "revoked" ? "revoked" : body.reason === "expired" ? "expired" : "invalid";
    return finish(
      { status, reason: body.reason ?? "invalid", ...base, lastCheckedAt: now, source: "server" },
      { firstServerFailAt: undefined },
    );
  } catch {
    // 5) Server unreachable — grace period (§3: no immediate blocking)
    const graceBase = prev?.lastServerOkAt ?? persisted.firstServerFailAt ?? now;
    const graceMs = env.LICENSE_GRACE_DAYS * 86_400_000;
    const inGrace = now - graceBase <= graceMs;
    return finish(
      {
        status: inGrace ? "grace" : "grace_expired",
        reason: "license_server_unreachable",
        ...base,
        lastCheckedAt: now,
        source: "server",
      },
      { firstServerFailAt: persisted.firstServerFailAt ?? now },
    );
  }
}

/** In-process license worker — once right after startup + hourly (same pattern as the embedding worker).
 *  Why 1h: the unpatched banner (release feed check) is tied to this cycle; 12h is too lax for opt-out installs (decided 2026-08-13) */
export function startLicenseWorker(
  db: Db,
  env: LicenseEnv,
  coreVersion: string,
  intervalMs = 3600_000,
): () => void {
  const run = async () => {
    try {
      await checkLicense(db, env, coreVersion);
    } catch {
      /* failures are retried on the next tick */
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
