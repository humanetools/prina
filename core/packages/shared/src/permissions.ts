/**
 * Permission subject namespace (T2.2) — constants shared by Backend/Admin/MCP.
 * - Content types: `content:<uid>` (all = `content:*`)
 * - System resources: `system:<key>`
 * - Everything: `*`
 */

export enum SystemSubject {
  ContentTypeBuilder = "system:ctb",
  Components = "system:components",
  Media = "system:media",
  Taxonomy = "system:taxonomy",
  Templates = "system:templates",
  /** Saving script.js — developer role only (§2.4, T2.2 DoD) */
  TemplateScript = "system:template_script",
  Workflows = "system:workflows",
  Locales = "system:locales",
  UsersRoles = "system:users",
  Settings = "system:settings",
  McpConsole = "system:mcp",
}

export const ALL_SUBJECTS = "*";
export const ALL_CONTENT = "content:*";

export function contentSubject(typeUid: string): string {
  return `content:${typeUid}`;
}

/** Default role names (seeded at workspace creation) */
export enum DefaultRole {
  Admin = "admin",
  Developer = "developer",
  Editor = "editor",
  Publisher = "publisher",
}
