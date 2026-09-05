/** S3-compatible adapter (T4.1) — AWS S3 / MinIO. imgproxy uses the same bucket as its source */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter } from "./adapter.js";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export function createS3Adapter(cfg: S3Config): StorageAdapter {
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
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
    async downloadUrl(key) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
        { expiresIn: 3600 },
      );
    },
  };
}
