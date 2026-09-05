/** RBAC matching logic (T2.2) — pure functions. type × CRUD × field × locale */
import type { PermissionRequest } from "../../commands/context.js";

export interface PermissionRow {
  action: string;
  subject: string;
  fields: string[] | null;
  locales: string[] | null;
}

/** subject patterns: '*' matches all, 'content:*' prefix wildcard, otherwise exact match */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern === "*" || pattern === subject) return true;
  if (pattern.endsWith(":*")) return subject.startsWith(pattern.slice(0, -1));
  return false;
}

export function applicablePermissions(
  perms: PermissionRow[],
  req: Pick<PermissionRequest, "action" | "subject" | "locale">,
): PermissionRow[] {
  return perms.filter(
    (p) =>
      (p.action === "*" || p.action === req.action) &&
      subjectMatches(p.subject, req.subject) &&
      (!req.locale || !p.locales || p.locales.includes(req.locale)),
  );
}

export interface WriteCheck {
  allowed: boolean;
  deniedFields?: string[];
}

/** Whether action+subject+locale is allowed, plus the list of field-level denied fields */
export function checkPermission(
  perms: PermissionRow[],
  req: PermissionRequest,
): WriteCheck {
  const applicable = applicablePermissions(perms, req);
  if (applicable.length === 0) return { allowed: false };
  if (!req.fields || req.fields.length === 0) return { allowed: true };
  const denied = req.fields.filter(
    (f) => !applicable.some((p) => !p.fields || p.fields.includes(f)),
  );
  return denied.length > 0 ? { allowed: false, deniedFields: denied } : { allowed: true };
}

/**
 * Set of readable fields — null means all allowed.
 * Used for response masking (T2.2): strips the values themselves so nothing leaks via UI or MCP.
 */
export function readableFields(
  perms: PermissionRow[],
  subject: string,
  locale?: string,
): string[] | null {
  const applicable = applicablePermissions(perms, { action: "read", subject, locale });
  if (applicable.length === 0) return [];
  if (applicable.some((p) => !p.fields)) return null;
  return [...new Set(applicable.flatMap((p) => p.fields ?? []))];
}

export function maskValues(
  values: Record<string, unknown>,
  allowed: string[] | null,
): Record<string, unknown> {
  if (allowed === null) return values;
  const set = new Set(allowed);
  return Object.fromEntries(Object.entries(values).filter(([k]) => set.has(k)));
}
