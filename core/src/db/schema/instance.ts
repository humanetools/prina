/**
 * Instance-level settings (T2.1) — global state outside any workspace.
 * Setup wizard progress/completion flags (§3.4), later license state (Phase 8), etc.
 */
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
