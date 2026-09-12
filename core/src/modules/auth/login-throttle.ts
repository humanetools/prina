/**
 * Login throttle — the admin sign-in is reachable from the internet whenever an install
 * claims a public address (the OAuth screen needs /api/auth/login), so unlimited guessing
 * against a password is a real exposure, not a theoretical one.
 *
 * In-process and per-instance on purpose: a self-hosted CMS runs one core, and a shared
 * store would add infrastructure to defend a surface that a lockout already closes.
 * Counted per (username, IP) pair so one attacker cannot lock a real user out by guessing
 * their name from another address.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

export interface ThrottleVerdict {
  /** Seconds the caller must wait; 0 when the attempt may proceed */
  retryAfter: number;
}

interface Bucket {
  failures: number;
  /** When the current lockout ends (0 = not locked) */
  until: number;
  seenAt: number;
}

export interface LoginThrottle {
  check(key: string): ThrottleVerdict;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const buckets = new Map<string, Bucket>();

  /** Old buckets are dropped lazily — a long-running install must not grow this map forever */
  const sweep = (t: number) => {
    if (buckets.size < 512) return;
    for (const [k, b] of buckets) {
      if (t - b.seenAt > WINDOW_MS && b.until < t) buckets.delete(k);
    }
  };

  return {
    check(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b) return { retryAfter: 0 };
      if (b.until > t) return { retryAfter: Math.ceil((b.until - t) / 1000) };
      // The window lapsed without a lockout — start counting again
      if (t - b.seenAt > WINDOW_MS) buckets.delete(key);
      return { retryAfter: 0 };
    },
    recordFailure(key) {
      const t = now();
      sweep(t);
      const b = buckets.get(key) ?? { failures: 0, until: 0, seenAt: t };
      if (t - b.seenAt > WINDOW_MS && b.until < t) b.failures = 0;
      b.failures += 1;
      b.seenAt = t;
      if (b.failures >= MAX_FAILURES) {
        // Back off further on each additional failure: 1m, 2m, 4m … capped at the window
        const extra = b.failures - MAX_FAILURES;
        b.until = t + Math.min(WINDOW_MS, 60_000 * 2 ** extra);
      }
      buckets.set(key, b);
    },
    recordSuccess(key) {
      buckets.delete(key);
    },
  };
}
