/**
 * Login throttle — the sign-in endpoint is internet-reachable once an install claims a
 * public address, so this is the difference between "guessable" and "not".
 */
import { describe, it, expect } from "vitest";
import { createLoginThrottle } from "../src/modules/auth/login-throttle.js";

const KEY = "aiden|203.0.113.7";

describe("login throttle", () => {
  it("lets normal typos through — a lockout that fires on the third try is a support ticket", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 7; i += 1) {
      expect(t.check(KEY).retryAfter).toBe(0);
      t.recordFailure(KEY);
    }
    expect(t.check(KEY).retryAfter).toBe(0);
  });

  it("locks out after repeated failures and reports how long to wait", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 8; i += 1) t.recordFailure(KEY);
    const v = t.check(KEY);
    expect(v.retryAfter).toBeGreaterThan(0);
    expect(v.retryAfter).toBeLessThanOrEqual(60);
  });

  it("backs off further the longer the guessing continues", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 8; i += 1) t.recordFailure(KEY);
    const first = t.check(KEY).retryAfter;
    t.recordFailure(KEY);
    const second = t.check(KEY).retryAfter;
    expect(second).toBeGreaterThan(first);
  });

  it("a successful sign-in clears the count", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 8; i += 1) t.recordFailure(KEY);
    t.recordSuccess(KEY);
    expect(t.check(KEY).retryAfter).toBe(0);
  });

  it("the lockout expires on its own", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 8; i += 1) t.recordFailure(KEY);
    expect(t.check(KEY).retryAfter).toBeGreaterThan(0);
    now += 61_000;
    expect(t.check(KEY).retryAfter).toBe(0);
  });

  it("one attacker cannot lock out a real user from another address", () => {
    let now = 1_000_000;
    const t = createLoginThrottle(() => now);
    for (let i = 0; i < 12; i += 1) t.recordFailure("aiden|198.51.100.1");
    expect(t.check("aiden|203.0.113.7").retryAfter).toBe(0);
  });
});
