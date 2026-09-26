/**
 * Local filesystem adapter (T4.1) — fallback for environments without S3 (dev/demo).
 * presign issues an HMAC-signed URL pointing at core's own upload route (stateless).
 * The production standard is S3 — this adapter is single-node only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter } from "./adapter.js";

/** Signing secret kept for the process lifetime (local adapter only) */
const uploadSecret = randomBytes(32);

export function signLocalUpload(key: string, expiresAt: number): string {
  return createHmac("sha256", uploadSecret)
    .update(`${key}:${expiresAt}`)
    .digest("base64url");
}

export function verifyLocalUpload(key: string, expiresAt: number, sig: string): boolean {
  if (Date.now() > expiresAt) return false;
  const expected = signLocalUpload(key, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safePath(baseDir: string, key: string): string {
  const resolved = path.resolve(baseDir, key);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return resolved;
}

export function createLocalAdapter(baseDir: string): StorageAdapter {
  return {
    kind: "local",
    async presignUpload(key, _mime, expiresSec = 600) {
      const expiresAt = Date.now() + expiresSec * 1000;
      const sig = signLocalUpload(key, expiresAt);
      const url = `/api/assets/local-upload?key=${encodeURIComponent(key)}&expires=${expiresAt}&sig=${sig}`;
      return { url, method: "PUT", expiresIn: expiresSec };
    },
    async put(key, body) {
      const filePath = safePath(baseDir, key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, body);
    },
    async head(key) {
      try {
        const s = await stat(safePath(baseDir, key));
        return { size: s.size };
      } catch {
        return null;
      }
    },
    async read(key, maxBytes) {
      try {
        const buf = await readFile(safePath(baseDir, key));
        return maxBytes && buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(safePath(baseDir, key), { force: true });
    },
    async downloadUrl(key) {
      return `/api/assets/raw/${encodeURIComponent(key)}`;
    },
  };
}
