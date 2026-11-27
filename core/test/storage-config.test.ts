/** Storage adapter selection — a half-configured S3 must not silently become local disk */
import { describe, expect, it, vi } from "vitest";
import { createStorageServices } from "../src/storage/index.js";
import { createS3Adapter, usesPathStyle } from "../src/storage/s3.js";

const base = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  IMGPROXY_URL: undefined,
  IMGPROXY_KEY: undefined,
  IMGPROXY_SALT: undefined,
  LOCAL_STORAGE_DIR: undefined,
} as const;

const s3 = { S3_BUCKET: "b", S3_ACCESS_KEY: "ak", S3_SECRET_KEY: "sk" } as const;
const none = { S3_BUCKET: undefined, S3_ACCESS_KEY: undefined, S3_SECRET_KEY: undefined } as const;
const partial = { S3_BUCKET: "b", S3_ACCESS_KEY: undefined, S3_SECRET_KEY: undefined } as const;

describe("createStorageServices — S3 configuration completeness", () => {
  it("throws in production when only some S3 keys are set, naming the missing ones", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      createStorageServices({ ...base, ...partial, NODE_ENV: "production" }, log),
    ).toThrow(/missing S3_ACCESS_KEY, S3_SECRET_KEY/);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to local storage with a warning outside production", () => {
    const log = { warn: vi.fn() };
    const { adapter, imgproxy } = createStorageServices(
      { ...base, ...partial, NODE_ENV: "development" },
      log,
    );
    expect(adapter.kind).toBe("local");
    expect(imgproxy).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(/missing S3_ACCESS_KEY, S3_SECRET_KEY/);
  });

  it("uses local storage silently when no S3 key is set, even in production", () => {
    const log = { warn: vi.fn() };
    const { adapter } = createStorageServices({ ...base, ...none, NODE_ENV: "production" }, log);
    expect(adapter.kind).toBe("local");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses the S3 adapter when all three keys are set", () => {
    const log = { warn: vi.fn() };
    const { adapter } = createStorageServices({ ...base, ...s3, NODE_ENV: "production" }, log);
    expect(adapter.kind).toBe("s3");
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("S3 addressing style", () => {
  it("keeps path style for self-hosted S3 endpoints", () => {
    expect(usesPathStyle("http://localhost:9000")).toBe(true);
    expect(usesPathStyle("https://abc.storage.supabase.co/storage/v1/s3")).toBe(true);
  });

  it("uses virtual-hosted style for Alibaba Cloud OSS, which rejects path style", () => {
    expect(usesPathStyle("https://oss-ap-southeast-1.aliyuncs.com")).toBe(false);
    expect(usesPathStyle("https://oss-cn-hangzhou-internal.aliyuncs.com")).toBe(false);
    expect(usesPathStyle("https://example.com/aliyuncs.com")).toBe(true);
  });

  it("lets an explicit setting win in both directions", () => {
    expect(usesPathStyle("https://oss-ap-southeast-1.aliyuncs.com", true)).toBe(true);
    expect(usesPathStyle("http://localhost:9000", false)).toBe(false);
  });

  it("leaves AWS S3 (no endpoint) on the SDK default", () => {
    expect(usesPathStyle(undefined)).toBe(false);
  });

  it("puts the bucket in the host name of signed URLs for OSS and in the path otherwise", async () => {
    const credentials = { region: "oss-ap-southeast-1", bucket: "media", accessKey: "ak", secretKey: "sk" };
    const oss = createS3Adapter({ ...credentials, endpoint: "https://oss-ap-southeast-1.aliyuncs.com" });
    expect(new URL(await oss.downloadUrl("a/b.png")).host).toBe("media.oss-ap-southeast-1.aliyuncs.com");
    const minio = createS3Adapter({ ...credentials, endpoint: "http://localhost:9000" });
    const url = new URL(await minio.downloadUrl("a/b.png"));
    expect(url.host).toBe("localhost:9000");
    expect(url.pathname).toBe("/media/a/b.png");
  });

  it("reads S3_FORCE_PATH_STYLE from the environment", async () => {
    const { adapter } = createStorageServices({
      ...base,
      ...s3,
      S3_BUCKET: "media", // a one-letter bucket name is never virtual-hostable
      NODE_ENV: "production",
      S3_FORCE_PATH_STYLE: "false",
    });
    expect(new URL(await adapter.downloadUrl("k")).host).toBe("media.localhost:9000");
  });
});
