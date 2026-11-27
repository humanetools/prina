/**
 * Setup wizard (T2.1, §3.4) — 5 steps:
 * ① admin account → ② workspace → ③ locales → ④ complete
 * State is stored in instance_settings['setup']. While incomplete, the HTTP gate blocks all routes.
 */
import { and, eq } from "drizzle-orm";
import { instanceSettings, locales, users, workspaces } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";
import { ConflictError, ValidationError } from "../../lib/errors.js";
import { hashPassword } from "../auth/passwords.js";

export interface SetupState {
  adminCreated: boolean;
  workspaceConfigured: boolean;
  localesConfigured: boolean;
  completed: boolean;
}

const EMPTY_STATE: SetupState = {
  adminCreated: false,
  workspaceConfigured: false,
  localesConfigured: false,
  completed: false,
};

export async function getSetupState(db: Db): Promise<SetupState> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "setup"))
    .limit(1);
  return { ...EMPTY_STATE, ...((row?.value as Partial<SetupState>) ?? {}) };
}

async function patchSetupState(db: Db, patch: Partial<SetupState>): Promise<SetupState> {
  const next = { ...(await getSetupState(db)), ...patch };
  await db
    .insert(instanceSettings)
    .values({ key: "setup", value: next as unknown as Record<string, unknown> })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: next as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
  return next;
}

/** Step 1: instance admin account */
export async function setupAdmin(
  db: Db,
  input: { username: string; password: string; name: string },
): Promise<{ userId: string }> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isInstanceAdmin, true))
    .limit(1);
  if (existing) throw new ConflictError("An administrator account already exists");
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      isInstanceAdmin: true,
    })
    .returning();
  await patchSetupState(db, { adminCreated: true });
  return { userId: user!.id };
}

/** Step 2: configure the default workspace */
export async function setupWorkspace(
  db: Db,
  input: { name: string; settings?: Record<string, unknown> },
): Promise<void> {
  await db
    .update(workspaces)
    .set({ name: input.name, settings: input.settings ?? {}, updatedAt: new Date() })
    .where(eq(workspaces.slug, "default"));
  await patchSetupState(db, { workspaceConfigured: true });
}

/** Step 3: configure locales (exactly one default locale required) */
export async function setupLocales(
  db: Db,
  input: { locales: Array<{ code: string; name: string; isDefault?: boolean }> },
): Promise<void> {
  const defaults = input.locales.filter((l) => l.isDefault);
  if (defaults.length !== 1) {
    throw new ValidationError("Exactly one default locale must be set");
  }
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, "default"))
    .limit(1);
  if (!ws) throw new ValidationError("No default workspace");

  for (const l of input.locales) {
    const [existing] = await db
      .select({ id: locales.id })
      .from(locales)
      .where(and(eq(locales.workspaceId, ws.id), eq(locales.code, l.code)))
      .limit(1);
    if (existing) {
      await db
        .update(locales)
        .set({ name: l.name, isDefault: l.isDefault ?? false })
        .where(eq(locales.id, existing.id));
    } else {
      await db.insert(locales).values({
        workspaceId: ws.id,
        code: l.code,
        name: l.name,
        isDefault: l.isDefault ?? false,
      });
    }
  }
  await patchSetupState(db, { localesConfigured: true });
}

/** Step 4: complete */
export async function completeSetup(db: Db): Promise<SetupState> {
  const state = await getSetupState(db);
  const missing = (
    ["adminCreated", "workspaceConfigured", "localesConfigured"] as const
  ).filter((k) => !state[k]);
  if (missing.length > 0) {
    throw new ValidationError(`Some steps are not complete: ${missing.join(", ")}`);
  }
  return patchSetupState(db, { completed: true });
}
