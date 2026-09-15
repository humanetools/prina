/** Test helpers — isolate each test file with its own workspace */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { ActorType, DefaultRole } from "@prina/shared";
import { createDb, type Db } from "../src/db/client.js";
import {
  instanceSettings,
  roles,
  userRoles,
  users,
  workspaces,
} from "../src/db/schema/index.js";
import { seedWorkspaceDefaults } from "../src/bootstrap.js";
import { createSession } from "../src/modules/auth/sessions.js";
import { createServices } from "../src/app.js";
import { loadEe } from "../src/ee-loader.js";
import { createLocalAdapter } from "../src/storage/index.js";
import type { CommandCtx, Services } from "../src/commands/context.js";

export interface TestContext {
  db: Db;
  pool: { end(): Promise<void> };
  services: Services;
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
  /** Command context for a human actor */
  ctx: CommandCtx;
  /** AI actor context (bound to admin role — for verifying human/ai distinction in audit logs) */
  aiCtx: CommandCtx;
  /** Look up role id by name (default presets: admin/developer/editor/publisher) */
  roleId(name: string): string;
  /** Create a user context with only the given roles (for RBAC tests) */
  createUserCtx(roleNames: string[]): Promise<{ ctx: CommandCtx; userId: string }>;
  /** Browser session token for the default test user (for cookie-flow tests) */
  createSession(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function setupTestContext(): Promise<TestContext> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is unset — global-setup did not run");
  const { db, pool } = createDb(url);

  // With ee present (full tree): 4-stage workflow + guard — under the OSS gate (src/ee removed): core defaults
  const ee = await loadEe();

  const suffix = randomUUID().slice(0, 8);
  const [ws] = await db
    .insert(workspaces)
    .values({ slug: `test-${suffix}`, name: `Test ${suffix}` })
    .returning();
  await seedWorkspaceDefaults(db, ws!.id, ee?.workflowPreset);

  // Seed the completed flag so HTTP tests pass the setup gate (auth.test resets it itself)
  await db
    .insert(instanceSettings)
    .values({
      key: "setup",
      value: {
        adminCreated: true,
        workspaceConfigured: true,
        localesConfigured: true,
        completed: true,
      },
    })
    .onConflictDoNothing();

  // Default test user = instance admin (bypasses RBAC — individual RBAC tests use createUserCtx)
  const [user] = await db
    .insert(users)
    .values({
      username: `tester-${suffix}`,
      name: "테스터",
      isInstanceAdmin: true,
    })
    .returning();

  const roleRows = await db.select().from(roles).where(eq(roles.workspaceId, ws!.id));
  const roleIdByName = new Map(roleRows.map((r) => [r.name, r.id]));
  const adminRoleId = roleIdByName.get(DefaultRole.Admin)!;

  // Storage: local adapter on a temp directory (no S3 needed)
  const storageDir = mkdtempSync(path.join(os.tmpdir(), "prina-test-storage-"));
  const services = createServices(
    {
      adapter: createLocalAdapter(storageDir),
      imgproxy: null,
    },
    ee,
  );
  const base = { db, workspaceId: ws!.id, services };
  return {
    db,
    pool,
    services,
    workspaceId: ws!.id,
    workspaceSlug: ws!.slug,
    userId: user!.id,
    ctx: { ...base, actor: { type: ActorType.Human, id: user!.id } },
    aiCtx: {
      ...base,
      actor: {
        type: ActorType.Ai,
        id: "mcp:ops-01",
        label: "ops-01",
        roleIds: [adminRoleId],
      },
    },
    roleId(name: string) {
      const id = roleIdByName.get(name);
      if (!id) throw new Error(`role '${name}' not seeded`);
      return id;
    },
    async createUserCtx(roleNames: string[]) {
      const [u] = await db
        .insert(users)
        .values({ username: `role-${randomUUID().slice(0, 8)}`, name: "role-user" })
        .returning();
      for (const name of roleNames) {
        // Also supports roles created mid-test — query live if absent from the snapshot
        let rid = roleIdByName.get(name);
        if (!rid) {
          const [row] = await db
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.workspaceId, ws!.id), eq(roles.name, name)))
            .limit(1);
          rid = row?.id;
        }
        if (!rid) throw new Error(`role '${name}' not seeded`);
        await db
          .insert(userRoles)
          .values({ userId: u!.id, roleId: rid, workspaceId: ws!.id });
      }
      return {
        ctx: { ...base, actor: { type: ActorType.Human, id: u!.id } },
        userId: u!.id,
      };
    },
    async createSession() {
      return createSession(db, user!.id);
    },
    async cleanup() {
      await pool.end();
    },
  };
}

/**
 * Edition-agnostic publish helper — goes straight through if the seeded workflow
 * is 2-stage (OSS), or via the review→approved chain if 4-stage (EE submission preset)
 * (IMPL-ee-boundary).
 */
export async function publishEntry(
  ctx: CommandCtx,
  typeUid: string,
  id: string,
): Promise<void> {
  const { entryTransition } = await import("../src/modules/entry/transition-commands.js");
  const { EntryStatus } = await import("@prina/shared");
  try {
    await entryTransition.run({ typeUid, id, to: EntryStatus.Published }, ctx);
  } catch {
    for (const to of [EntryStatus.Review, EntryStatus.Approved, EntryStatus.Published]) {
      await entryTransition.run({ typeUid, id, to }, ctx);
    }
  }
}
