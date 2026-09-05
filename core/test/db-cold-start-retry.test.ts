/** withColdStartRetry — one retry for a Postgres that is still waking up (hosted/serverless DBs) */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isColdStartError, withColdStartRetry } from "../src/db/client.js";

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg ${code}`), { code });
}

describe("withColdStartRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first result without waiting when the call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withColdStartRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once after 57P03 (cannot_connect_now) and returns the second result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgError("57P03")).mockResolvedValueOnce("ok");
    const p = withColdStartRetry(fn);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second 57P03 — exactly one retry", async () => {
    const fn = vi.fn().mockRejectedValue(pgError("57P03"));
    const p = withColdStartRetry(fn);
    const assertion = expect(p).rejects.toMatchObject({ code: "57P03" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a reset socket (ECONNRESET)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgError("ECONNRESET")).mockResolvedValueOnce(1);
    const p = withColdStartRetry(fn);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other error immediately without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(pgError("42P01")); // undefined_table
    await expect(withColdStartRetry(fn)).rejects.toMatchObject({ code: "42P01" });
    expect(fn).toHaveBeenCalledTimes(1);

    const plain = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withColdStartRetry(plain)).rejects.toThrow("boom");
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("isColdStartError recognizes only the cold-start signatures", () => {
    expect(isColdStartError(pgError("57P03"))).toBe(true);
    expect(isColdStartError(pgError("ECONNREFUSED"))).toBe(true);
    expect(isColdStartError(pgError("ETIMEDOUT"))).toBe(true);
    expect(isColdStartError(pgError("23505"))).toBe(false);
    expect(isColdStartError(new Error("x"))).toBe(false);
    expect(isColdStartError(null)).toBe(false);
  });
});
