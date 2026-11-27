/**
 * Login identifier rules (2026-08-17) — the admin account is local, so it is a username,
 * not an email. Kept in one place because setup, user creation and profile editing must
 * agree; a value accepted by one and rejected by another locks people out of their own install.
 *
 * 49-IMPL: an account that arrives through single sign-on or SCIM is named by its address, so an
 * address is also a valid identifier — otherwise editing such an account would be refused here.
 */
import { z } from "zod";

/** Lowercase letters, digits, dot/underscore/hyphen. 2–32 chars, must start with a letter or digit. */
export const USERNAME_PATTERN = "^[a-z0-9][a-z0-9._-]{1,31}$";

const usernameRe = new RegExp(USERNAME_PATTERN);
const addressRe = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercased, trimmed address — or null when it is not one */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && addressRe.test(v) ? v : null;
}

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (v) => usernameRe.test(v) || normalizeEmail(v) !== null,
    "Use 2-32 characters: lowercase letters, digits, dot, underscore or hyphen",
  );
