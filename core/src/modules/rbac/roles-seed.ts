/**
 * Default role presets (T2.2) — seeded on workspace creation.
 * DoD rationale:
 * - editor has no system:ctb write → CTB commands 403
 * - editor/publisher lack system:template_script → script.js save 403 (developer-only, §2.4)
 * - only publisher holds the publish action → basis of the "AI up to draft, humans publish" policy
 */
import { and, eq } from "drizzle-orm";
import {
  ALL_CONTENT,
  ALL_SUBJECTS,
  DefaultRole,
  PermissionAction,
  SystemSubject,
} from "@prina/shared";
import { permissions, roles } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

interface PermSpec {
  action: string;
  subject: string;
}

const CONTENT_CRUD: PermSpec[] = [
  { action: PermissionAction.Create, subject: ALL_CONTENT },
  { action: PermissionAction.Read, subject: ALL_CONTENT },
  { action: PermissionAction.Update, subject: ALL_CONTENT },
  { action: PermissionAction.Delete, subject: ALL_CONTENT },
  { action: PermissionAction.Transition, subject: ALL_CONTENT },
];

const READ_BASICS: PermSpec[] = [
  { action: PermissionAction.Read, subject: SystemSubject.ContentTypeBuilder },
  { action: PermissionAction.Read, subject: SystemSubject.Components },
  { action: PermissionAction.Read, subject: SystemSubject.Taxonomy },
  { action: PermissionAction.Read, subject: SystemSubject.Locales },
  { action: PermissionAction.Read, subject: SystemSubject.Workflows },
  { action: PermissionAction.Read, subject: SystemSubject.Templates },
];

/** Editors and developers get full media CRUD (everyday upload flow) */
const MEDIA_CRUD: PermSpec[] = [
  { action: "*", subject: SystemSubject.Media },
];

export const DEFAULT_ROLE_PERMISSIONS: Record<DefaultRole, PermSpec[]> = {
  [DefaultRole.Admin]: [{ action: "*", subject: ALL_SUBJECTS }],
  [DefaultRole.Developer]: [
    ...CONTENT_CRUD,
    ...READ_BASICS,
    ...MEDIA_CRUD,
    { action: "*", subject: SystemSubject.ContentTypeBuilder },
    { action: "*", subject: SystemSubject.Components },
    { action: "*", subject: SystemSubject.Templates },
    { action: "*", subject: SystemSubject.TemplateScript },
    { action: "*", subject: SystemSubject.Taxonomy },
  ],
  [DefaultRole.Editor]: [
    ...CONTENT_CRUD,
    ...READ_BASICS,
    ...MEDIA_CRUD,
    { action: PermissionAction.Update, subject: SystemSubject.Templates },
  ],
  [DefaultRole.Publisher]: [
    { action: PermissionAction.Read, subject: ALL_CONTENT },
    { action: PermissionAction.Transition, subject: ALL_CONTENT },
    { action: PermissionAction.Publish, subject: ALL_CONTENT },
    ...READ_BASICS,
    { action: PermissionAction.Read, subject: SystemSubject.Media },
  ],
};

export async function seedDefaultRoles(db: Db, workspaceId: string): Promise<void> {
  for (const [name, specs] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const [existing] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.name, name)))
      .limit(1);
    if (existing) continue;
    const [role] = await db
      .insert(roles)
      .values({ workspaceId, name, isSystem: true })
      .returning();
    await db.insert(permissions).values(
      specs.map((s) => ({
        workspaceId,
        roleId: role!.id,
        action: s.action,
        subject: s.subject,
        fields: null,
        locales: null,
        conditions: null,
      })),
    );
  }
}
