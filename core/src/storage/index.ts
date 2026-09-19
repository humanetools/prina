/** env → storage/imgproxy assembly (T4.1/T4.2) */
import path from "node:path";
import type { Env } from "../env.js";
import type { StorageAdapter } from "./adapter.js";
import { createS3Adapter } from "./s3.js";
import { createLocalAdapter } from "./local.js";
import { createImgproxySigner, type ImgproxySigner } from "./imgproxy.js";

export interface StorageServices {
  adapter: StorageAdapter;
  /** null when imgproxy is not configured (local adapter, etc.) — serve originals only, no renditions */
  imgproxy: ImgproxySigner | null;
}

const S3_REQUIRED_KEYS = ["S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;

export function createStorageServices(
  env: Pick<
    Env,
    | "NODE_ENV"
    | "S3_ENDPOINT" | "S3_BUCKET" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "S3_REGION"
    | "IMGPROXY_URL" | "IMGPROXY_KEY" | "IMGPROXY_SALT" | "LOCAL_STORAGE_DIR"
  > &
    Partial<Pick<Env, "IMGPROXY_PUBLIC_URL">>,
  log: { warn: (msg: string) => void } = console,
): StorageServices {
  const missing = S3_REQUIRED_KEYS.filter((k) => !env[k]);
  const s3Configured = missing.length === 0;
  // A half-configured S3 used to fall back to local disk without a word — in a hosted
  // deployment that silently writes uploads to an ephemeral container filesystem.
  // Production refuses to start; development/test keep the fallback but say so.
  if (!s3Configured && missing.length < S3_REQUIRED_KEYS.length) {
    const message =
      `S3 storage is partially configured — missing ${missing.join(", ")} ` +
      `(set all of ${S3_REQUIRED_KEYS.join(", ")}, or none to use local storage)`;
    if (env.NODE_ENV === "production") throw new Error(message);
    log.warn(`[prina-core] ${message}; falling back to local storage`);
  }
  const adapter: StorageAdapter = s3Configured
    ? createS3Adapter({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET!,
        accessKey: env.S3_ACCESS_KEY!,
        secretKey: env.S3_SECRET_KEY!,
      })
    : createLocalAdapter(
        path.resolve(env.LOCAL_STORAGE_DIR ?? ".prina-storage"),
      );

  const imgproxy =
    s3Configured && env.IMGPROXY_URL && env.IMGPROXY_KEY && env.IMGPROXY_SALT
      ? createImgproxySigner({
          // IMGPROXY_URL is the internal address (127.0.0.1 / compose service name) and is
          // unreachable from a browser — rendition URLs point at the core's /img proxy
          // instead (registered in app.ts), or at IMGPROXY_PUBLIC_URL when the operator
          // needs an absolute base.
          baseUrl: env.IMGPROXY_PUBLIC_URL ?? "/img",
          keyHex: env.IMGPROXY_KEY,
          saltHex: env.IMGPROXY_SALT,
          bucket: env.S3_BUCKET!,
        })
      : null;

  return { adapter, imgproxy };
}

export * from "./adapter.js";
export { createLocalAdapter, verifyLocalUpload } from "./local.js";
export { DEFAULT_RENDITIONS, type RenditionPreset } from "./imgproxy.js";
