/**
 * EE loader (IMPL-ee-boundary, admin) — the only core→ee reference is this file's import.meta.glob.
 * OSS build = src/ee physically removed: the glob returns an empty object so adminEe = null,
 * and the EE chunk is never bundled at all. Every consuming site falls back via adminEe?.…
 */
import type { ComponentType } from "react";

export interface AdminEe {
  /** Settings side items + child routes (workflow guard editing, audit log) */
  settingsItems: Array<{ to: string; label: string }>;
  settingsRoutes: Array<{ path: string; Component: ComponentType }>;
  /**
   * Tier-1 icon-rail items rendered ABOVE the core menu + their top-level routes
   * (chatbot section, 2026-09-01). Icon: 2rem 20-viewBox stroke SVG like the core rail.
   */
  navItems?: Array<{ to: string; label: string; icon: import("react").ReactNode }>;
  navRoutes?: Array<{ path: string; Component: ComponentType }>;
  /** CM right panel — recent activity (depends on the audit query API) */
  EntryActivitySection: ComponentType<{ entryId: string }>;
  /** CM — version history/restore modal (versioning) */
  VersionHistoryModal: ComponentType<{ typeUid: string; entryId: string; onClose(): void }>;
  /** MCP console — AI activity log tab (label is EE-owned too) */
  mcpActivityItem: { key: "activity"; label: string };
  McpActivitySection: ComponentType;
  /** CM right panel — version history button and guard lock card (strings live in EE too) */
  VersionHistoryButton: ComponentType<{ onClick(): void }>;
  TransitionLockCard: ComponentType<{ toState: string }>;
  /** Users & Roles — custom role CRUD actions (creation/edit/delete are EE) */
  RoleManagerActions: ComponentType<{ role?: import("./api/types").Role }>;
  /** CTB type editor — "exclude from chatbot knowledge" switch (10-IMPL-chatbot §4.0a) */
  ChatbotTypeToggle?: ComponentType<{ contentType: import("./api/types").ContentType }>;
  /** CM right panel — per-entry chatbot exclusion switch (10-IMPL-chatbot §4.0a) */
  ChatbotEntryToggle?: ComponentType<{ entryId: string }>;
  /**
   * CM create view — one-shot initial values an EE flow stashed for this type (10-IMPL-chatbot
   * C3 §7 gap report). Consumed on read; null = start with an empty form.
   */
  consumeCreatePrefill?: (typeUid: string) => Record<string, unknown> | null;
}

const mods = import.meta.glob("./ee/index.tsx", { eager: true }) as Record<
  string,
  { adminEe: AdminEe }
>;

export const adminEe: AdminEe | null = Object.values(mods)[0]?.adminEe ?? null;
