/** Storage adapter selection — a half-configured S3 must not silently become local disk */
import { describe, expect, it, vi } from "vitest";
import { createStorageServices } from "../src/storage/index.js";

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
