/** 49-IMPL — sealing secrets at rest (lib/secret-box) and identifiers that are addresses */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createSecretBox, parseSecretKey, secretBoxFromEnv } from "../src/lib/secret-box.js";
import { normalizeEmail, usernameSchema } from "../src/modules/auth/username.js";

describe("secret box", () => {
  const key = randomBytes(32);

  it("opens what it sealed, and seals the same text differently each time", () => {
    const box = createSecretBox(key);
    const a = box.seal("client-secret ✓");
    const b = box.seal("client-secret ✓");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain("client-secret");
    expect(box.open(a)).toBe("client-secret ✓");
    expect(box.open(b)).toBe("client-secret ✓");
  });

  it("refuses a tampered value and a different key", () => {
    const sealed = createSecretBox(key).seal("value");
    const parts = sealed.split(".");
    const flipped = [...parts.slice(0, 3), Buffer.from("other").toString("base64url")].join(".");
    expect(() => createSecretBox(key).open(flipped)).toThrow();
    expect(() => createSecretBox(randomBytes(32)).open(sealed)).toThrow();
    expect(() => createSecretBox(key).open("plain text")).toThrow();
  });

  it("accepts 64 hex characters or base64 of 32 bytes, nothing shorter", () => {
    expect(parseSecretKey(key.toString("hex"))?.equals(key)).toBe(true);
    expect(parseSecretKey(key.toString("base64"))?.equals(key)).toBe(true);
    expect(parseSecretKey(key.toString("base64url"))?.equals(key)).toBe(true);
    expect(parseSecretKey("too-short")).toBeNull();
    expect(parseSecretKey("")).toBeNull();
    expect(parseSecretKey(undefined)).toBeNull();
    expect(secretBoxFromEnv(undefined)).toBeNull();
    expect(secretBoxFromEnv(key.toString("hex"))).not.toBeNull();
  });
});

describe("identifiers", () => {
  it("a username keeps its rule; an address is also accepted", () => {
    expect(usernameSchema.parse("Kim.Lee")).toBe("kim.lee");
    expect(usernameSchema.parse(" Kim@Acme.Test ")).toBe("kim@acme.test");
    expect(usernameSchema.safeParse("a").success).toBe(false);
    expect(usernameSchema.safeParse("has space").success).toBe(false);
    expect(usernameSchema.safeParse("@acme.test").success).toBe(false);
  });

  it("normalizes addresses and rejects what is not one", () => {
    expect(normalizeEmail("Kim+Tag@Sub.Acme.Test")).toBe("kim+tag@sub.acme.test");
    expect(normalizeEmail("kim@localhost")).toBeNull();
    expect(normalizeEmail("kim")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});
