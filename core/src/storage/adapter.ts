/**
 * Storage abstraction (T4.1) — S3-compatible is the standard; local filesystem is a dev/demo fallback.
 * Principle 1: "runs with just Postgres + S3-compatible storage" — no dependencies other than the adapter.
 */

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers?: Record<string, string>;
  /** Expiry in seconds */
  expiresIn: number;
}

export interface StorageAdapter {
  kind: "s3" | "local";
  /** Signed URL for direct client uploads */
  presignUpload(key: string, mime: string, expiresSec?: number): Promise<PresignedUpload>;
  /** Server-side store (used by the local upload route, tests, and import) */
  put(key: string, body: Buffer, mime?: string): Promise<void>;
  /** Existence/size check. null if missing */
  head(key: string): Promise<{ size: number } | null>;
  /** Read for metadata extraction (may truncate beyond maxBytes). null if missing */
  read(key: string, maxBytes?: number): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Original download URL (S3=presigned GET, local=core serving path) */
  downloadUrl(key: string): Promise<string>;
}
