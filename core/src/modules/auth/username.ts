/**
 * Login identifier rules (2026-08-17) — the admin account is local, so it is a username,
 * not an email. Kept in one place because setup, user creation and profile editing must
 * agree; a value accepted by one and rejected by another locks people out of their own install.
 */
import { z } from "zod";

/** Lowercase letters, digits, dot/underscore/hyphen. 2–32 chars, must start with a letter or digit. */
export const USERNAME_PATTERN = "^[a-z0-9][a-z0-9._-]{1,31}$";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    new RegExp(USERNAME_PATTERN),
    "Use 2-32 characters: lowercase letters, digits, dot, underscore or hyphen",
  );
