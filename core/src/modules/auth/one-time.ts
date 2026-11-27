/**
 * One-time admin login tokens (IMPL-saas-cloud §3 ④) — Prina Cloud "Open admin".
 *
 * The control plane signs a short-lived token with its own Ed25519 key
 * (ONE_TIME_LOGIN_SIGNING_KEY — deliberately NOT the license signing key); the tenant
 * core verifies it with ONE_TIME_LOGIN_PUBLIC_KEY and exchanges it for a normal session.
 *
 * Format: base64url(payloadJson) + "." + base64url(ed25519Signature)
 * Payload: { sub, tenant, username, iat, exp, jti } — iat/exp are unix seconds,
 *          exp - iat must be within MAX_LIFETIME_SEC (the issuer defaults to 120s).
 *
 * Replay protection is an in-memory set of consumed `jti`s. Every tenant runs on a
 * single machine, so a process-local set is sufficient; a restart forgets consumed
 * ids, but the short lifetime bounds the window. Expired ids are swept on each call.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

export const oneTimePayloadSchema = z.object({
  /** Cloud account id that requested the link */
  sub: z.string().min(1),
  /** Tenant slug the link was issued for */
  tenant: z.string().min(1),
  /** Local username to sign in as (must be an instance admin) */
  username: z.string().min(1),
  /** Issued at — unix seconds */
  iat: z.number().int().nonnegative(),
  /** Expiry — unix seconds; at most MAX_LIFETIME_SEC after iat */
  exp: z.number().int().nonnegative(),
  /** Unique id — consumed on first use */
  jti: z.string().min(1),
});

export type OneTimePayload = z.infer<typeof oneTimePayloadSchema>;

export type OneTimeErrorReason = "malformed" | "bad_signature" | "expired" | "replayed";

export class OneTimeTokenError extends Error {
  constructor(public readonly reason: OneTimeErrorReason) {
    super(`one-time token rejected: ${reason}`);
    this.name = "OneTimeTokenError";
  }
}

/** Longest lifetime the core accepts, regardless of what the issuer put in `exp` */
export const MAX_LIFETIME_SEC = 300;
/** Tolerated clock skew for `iat` in the future */
const CLOCK_SKEW_SEC = 60;

/** jti → exp (unix seconds) of consumed tokens */
const consumed = new Map<string, number>();

function sweep(nowSec: number): void {
  for (const [jti, exp] of consumed) {
    if (exp < nowSec) consumed.delete(jti);
  }
}

/** Forget every consumed id — for tests only */
export function resetOneTimeReplayStore(): void {
  consumed.clear();
}

function decodePart(part: string): Buffer {
  // Buffer.from is lenient; reject anything that does not round-trip as base64url
  const buf = Buffer.from(part, "base64url");
  if (buf.length === 0 || buf.toString("base64url") !== part) {
    throw new OneTimeTokenError("malformed");
  }
  return buf;
}

/**
 * Verify signature, structure, lifetime and single use. Throws OneTimeTokenError.
 * `now` is a Date (defaults to the wall clock) so tests can move time.
 */
export function verifyOneTimeToken(
  token: string,
  publicKeyPem: string,
  now: Date = new Date(),
): OneTimePayload {
  const parts = token.trim().split(".");
  if (parts.length !== 2) throw new OneTimeTokenError("malformed");
  const body = decodePart(parts[0]!);
  const sig = decodePart(parts[1]!);

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new OneTimeTokenError("bad_signature");
  }
  let valid = false;
  try {
    valid = verify(null, body, key, sig);
  } catch {
    valid = false;
  }
  if (!valid) throw new OneTimeTokenError("bad_signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new OneTimeTokenError("malformed");
  }
  const result = oneTimePayloadSchema.safeParse(parsed);
  if (!result.success) throw new OneTimeTokenError("malformed");
  const payload = result.data;

  const lifetime = payload.exp - payload.iat;
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_SEC) throw new OneTimeTokenError("malformed");

  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) throw new OneTimeTokenError("malformed");
  if (payload.exp <= nowSec) throw new OneTimeTokenError("expired");

  sweep(nowSec);
  if (consumed.has(payload.jti)) throw new OneTimeTokenError("replayed");
  consumed.set(payload.jti, payload.exp);
  return payload;
}

/**
 * Produce a token in the exact format the core accepts. The control plane has its own
 * signer; this one exists so the core's tests pin the format both sides must agree on.
 */
export function signOneTimeToken(payload: OneTimePayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = sign(null, body, createPrivateKey(privateKeyPem));
  return `${body.toString("base64url")}.${sig.toString("base64url")}`;
}
