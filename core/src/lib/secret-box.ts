/**
 * Sealing secrets at rest (49-IMPL) — AES-256-GCM under PRINA_SECRET_KEY.
 *
 * The key is optional: an install without it runs as before, and only the features that must store
 * a secret (an identity provider's client secret) refuse to save. Nothing is ever written in the clear.
 *
 * Sealed form: `v1.<iv>.<tag>.<ciphertext>` (base64url). The version prefix leaves room to rotate.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

export class SecretKeyMissingError extends AppError {
  constructor() {
    super(
      "SECRET_KEY_REQUIRED",
      "PRINA_SECRET_KEY is not set on this install — secrets cannot be stored. Set it to 32 random bytes (64 hex characters) and restart.",
      409,
    );
  }
}

/** 64 hex characters or base64/base64url of exactly 32 bytes; anything else → null */
export function parseSecretKey(raw: string | undefined | null): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const buf = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length === 32) return buf;
  }
  return null;
}

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("secret key must be 32 bytes");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
    },
    open(sealed) {
      const [version, iv, tag, ct] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised sealed value");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** The box for this install, or null when no (valid) key is configured */
export function secretBoxFromEnv(raw: string | undefined | null): SecretBox | null {
  const key = parseSecretKey(raw);
  return key ? createSecretBox(key) : null;
}
