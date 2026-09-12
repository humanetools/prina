/**
 * License key verification (T8.2) — copy of the verification part of prina-license/src/license-format.ts.
 * ⚠ Sync both sides on format changes (same manual-copy convention as admin types.ts).
 *
 * Format: PRINA.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
 * The key itself is an offline-signed file — air-gapped installs work with just this check, no server.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

export const licensePayloadSchema = z.object({
  lid: z.string().min(1),
  customer: z.string().min(1),
  plan: z.string().min(1),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

const PREFIX = "PRINA";

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "bad_payload" };

/** Verify signature and structure (expiry is not judged here — caller applies time policy) */
export function verifyLicense(keyText: string, publicKeyPem: string): VerifyResult {
  const parts = keyText.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  let body: Buffer, sig: Buffer;
  try {
    body = Buffer.from(parts[1]!, "base64url");
    sig = Buffer.from(parts[2]!, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  let valid = false;
  try {
    valid = verify(null, body, key, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  const result = licensePayloadSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "bad_payload" };
  return { ok: true, payload: result.data };
}
