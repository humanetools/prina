/**
 * Cloud MCP connect tokens (19-IMPL-cloud-mcp §4 — `project_mcp_connect`).
 *
 * The control plane signs a short-lived bearer with the same Ed25519 key as one-time admin
 * login (ONE_TIME_LOGIN_SIGNING_KEY); this core verifies it with ONE_TIME_LOGIN_PUBLIC_KEY and
 * treats it as a management/delivery MCP token without creating a row in mcp_tokens.
 *
 * Format:  "pmt_ct_" + base64url(payloadJson) + "." + base64url(ed25519Signature)
 * Payload: { v: 1, purpose: "mcp", sub, tenant, plane, hosts, client, iat, exp, jti }
 *          — iat/exp are unix seconds; exp - iat must be within MAX_CONNECT_LIFETIME_SEC.
 *
 * The token is reusable until it expires (expiry is the revocation). It is bound to the tenant
 * by `hosts`: the request's Host must be one of them, so a token issued for tenant A cannot be
 * replayed against tenant B even though both trust the same public key. No replay store — the
 * client legitimately sends the same bearer on every request of a session.
 *
 * Self-hosted instances never set ONE_TIME_LOGIN_PUBLIC_KEY, so this surface does not exist there.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

export const CONNECT_TOKEN_PREFIX = "pmt_ct_";
/** Longest lifetime the core accepts, regardless of what the issuer put in `exp` */
export const MAX_CONNECT_LIFETIME_SEC = 3600;
const CLOCK_SKEW_SEC = 60;

export const connectPayloadSchema = z.object({
  v: z.literal(1),
  purpose: z.literal("mcp"),
  /** Cloud account id that asked for the connection */
  sub: z.string().min(1),
  /** Tenant slug the token was issued for */
  tenant: z.string().min(1),
  plane: z.enum(["management", "delivery"]),
  /** Hostnames this core answers on for that tenant — the request Host must match one */
  hosts: z.array(z.string().min(1)).min(1).max(10),
  /** MCP client name (DCR client_name or token name) — for audit labels */
  client: z.string().min(1).max(120),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().min(1),
});
export type ConnectPayload = z.infer<typeof connectPayloadSchema>;

export type ConnectErrorReason = "malformed" | "bad_signature" | "expired" | "wrong_host" | "wrong_plane";

export class ConnectTokenError extends Error {
  constructor(public readonly reason: ConnectErrorReason) {
    super(`connect token rejected: ${reason}`);
    this.name = "ConnectTokenError";
  }
}

export const isConnectToken = (raw: string): boolean => raw.startsWith(CONNECT_TOKEN_PREFIX);

function decodePart(part: string): Buffer {
  const buf = Buffer.from(part, "base64url");
  if (buf.length === 0 || buf.toString("base64url") !== part) throw new ConnectTokenError("malformed");
  return buf;
}

/** Strip the port and lower-case — what the Host header carries for a tenant */
export const normalizeHost = (host: string): string => host.split(",")[0]!.trim().split(":")[0]!.toLowerCase();

/**
 * Verify signature, structure, lifetime, plane and host binding. Throws ConnectTokenError.
 * `host` is the request's forwarded/host header (port allowed); `now` is injectable for tests.
 */
export function verifyConnectToken(
  raw: string,
  publicKeyPem: string,
  expected: { plane: "management" | "delivery"; host: string },
  now: Date = new Date(),
): ConnectPayload {
  if (!isConnectToken(raw)) throw new ConnectTokenError("malformed");
  const parts = raw.slice(CONNECT_TOKEN_PREFIX.length).trim().split(".");
  if (parts.length !== 2) throw new ConnectTokenError("malformed");
  const body = decodePart(parts[0]!);
  const sig = decodePart(parts[1]!);

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new ConnectTokenError("bad_signature");
  }
  let valid = false;
  try {
    valid = verify(null, body, key, sig);
  } catch {
    valid = false;
  }
  if (!valid) throw new ConnectTokenError("bad_signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ConnectTokenError("malformed");
  }
  const result = connectPayloadSchema.safeParse(parsed);
  if (!result.success) throw new ConnectTokenError("malformed");
  const payload = result.data;

  const lifetime = payload.exp - payload.iat;
  if (lifetime <= 0 || lifetime > MAX_CONNECT_LIFETIME_SEC) throw new ConnectTokenError("malformed");
  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) throw new ConnectTokenError("malformed");
  if (payload.exp <= nowSec) throw new ConnectTokenError("expired");
  if (payload.plane !== expected.plane) throw new ConnectTokenError("wrong_plane");
  const host = normalizeHost(expected.host);
  if (!payload.hosts.map(normalizeHost).includes(host)) throw new ConnectTokenError("wrong_host");
  return payload;
}
