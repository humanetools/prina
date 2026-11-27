/** S3-compatible adapter (T4.1) — AWS S3 / MinIO. imgproxy uses the same bucket as its source */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { attachmentDisposition } from "../lib/content-disposition.js";
import type { StorageAdapter } from "./adapter.js";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** Explicit addressing style (S3_FORCE_PATH_STYLE). Unset = decided from the endpoint, see usesPathStyle */
  forcePathStyle?: boolean;
}

/** Hosts that only accept virtual-hosted-style requests (`<bucket>.<host>/<key>`) and reject path-style ones */
const VIRTUAL_HOSTED_ONLY = [/(^|\.)aliyuncs\.com$/i];

/**
 * Addressing style for a custom endpoint. Path style (`<host>/<bucket>/<key>`) is what MinIO, RustFS,
 * Supabase Storage and most self-hosted S3 servers need, so it stays the default. Alibaba Cloud OSS
 * refuses path style, so its endpoints use virtual-hosted style without any setting. An explicit
 * value always wins. Without an endpoint (AWS S3 itself) the SDK default, virtual-hosted, applies.
 */
export function usesPathStyle(endpoint: string | undefined, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (!endpoint) return false;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return true;
  }
  return !VIRTUAL_HOSTED_ONLY.some((pattern) => pattern.test(host));
}

export function createS3Adapter(cfg: S3Config): StorageAdapter {
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint
      ? { endpoint: cfg.endpoint, forcePathStyle: usesPathStyle(cfg.endpoint, cfg.forcePathStyle) }
      : cfg.forcePathStyle !== undefined
        ? { forcePathStyle: cfg.forcePathStyle }
        : {}),
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });

  return {
    kind: "s3",
    async presignUpload(key, mime, expiresSec = 600) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: mime }),
        { expiresIn: expiresSec },
      );
      return { url, method: "PUT", headers: { "content-type": mime }, expiresIn: expiresSec };
    },
    async put(key, body, mime) {
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: mime }),
      );
    },
    async head(key) {
      try {
        const res = await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
        );
        return { size: res.ContentLength ?? 0 };
      } catch {
        return null;
      }
    },
    async read(key, maxBytes) {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket: cfg.bucket,
            Key: key,
            ...(maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : {}),
          }),
        );
        const bytes = await res.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch {
        return null;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
    async downloadUrl(key, attachment) {
      // The disposition is part of the signed request, so it cannot be stripped or altered client-side
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ...(attachment ? { ResponseContentDisposition: attachmentDisposition(attachment) } : {}),
        }),
        { expiresIn: 3600 },
      );
    },
  };
}
