-- Login identifier: email → username (2026-08-17).
-- A self-hosted install's first account is a local admin, so the setup wizard asks for an
-- ID; the work email is collected later, only when a public address is claimed.
-- Existing rows keep working: the local part of the email becomes the username, and any
-- collision gets a numeric suffix so the unique index still holds.
ALTER TABLE "users" RENAME COLUMN "email" TO "username";--> statement-breakpoint
UPDATE "users" u
SET "username" = sub.candidate
FROM (
  SELECT id,
         CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS candidate
  FROM (
    SELECT id,
           regexp_replace(lower(split_part("username", '@', 1)), '[^a-z0-9._-]', '-', 'g') AS base,
           row_number() OVER (
             PARTITION BY regexp_replace(lower(split_part("username", '@', 1)), '[^a-z0-9._-]', '-', 'g')
             ORDER BY "created_at"
           ) AS rn
    FROM "users"
  ) ranked
) sub
WHERE u.id = sub.id;
