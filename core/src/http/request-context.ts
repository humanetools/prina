/**
 * HTTP request → CommandCtx adapter (switched to session-based in T2.1).
 * - Actor: req.prinaActor resolved from the session by auth-hooks (x-prina-actor header fallback limited to dev/test)
 * - Workspace: x-prina-workspace slug header (workspace switcher, defaults to 'default')
 * - Membership: unless an instance admin, the actor must have a role in that workspace
 */
import type { FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { ActorType } from "@prina/shared";
import { userRoles, users, workspaces } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { Actor, CommandCtx, Services } from "../commands/context.js";

const workspaceIdCache = new Map<string, { id: string; at: number }>();
const CACHE_TTL_MS = 30_000;

export async function resolveWorkspaceId(db: Db, slug: string): Promise<string> {
  const hit = workspaceIdCache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.id;
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  if (!row) throw new NotFoundError(`Workspace '${slug}' not found`);
  workspaceIdCache.set(slug, { id: row.id, at: Date.now() });
  return row.id;
}

export function parseActor(header: string | undefined): Actor {
  if (!header) return { type: ActorType.System };
  const [kind, ...rest] = header.split(":");
  const id = rest.join(":");
  if (kind === "human" && id) return { type: ActorType.Human, id };
  if (kind === "ai" && id) return { type: ActorType.Ai, id: `mcp:${id}`, label: id };
  return { type: ActorType.System };
}

async function assertWorkspaceMembership(
  db: Db,
  workspaceId: string,
  actor: Actor,
): Promise<void> {
  if (actor.type !== ActorType.Human || !actor.id) return;
  const [user] = await db
    .select({ isInstanceAdmin: users.isInstanceAdmin })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);
  if (user?.isInstanceAdmin) return;
  const [membership] = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, actor.id), eq(userRoles.workspaceId, workspaceId)))
    .limit(1);
  if (!membership) {
    throw new ForbiddenError("You do not have access to this workspace");
  }
}

/**
 * identity-scoped context — for workspace-independent commands like My Account.
 * No workspace is required, so no membership check either (the target is the actor itself).
 */
export async function buildIdentityCtx(
  req: FastifyRequest,
  db: Db,
  services: Services,
): Promise<CommandCtx> {
  const actor: Actor =
    req.prinaActor ??
    parseActor(req.headers["x-prina-actor"] as string | undefined);
  // workspace_id in audit logs is nullable — an empty value is recorded as an instance-level event
  return { db, workspaceId: "", actor, services };
}

export async function buildCommandCtx(
  req: FastifyRequest,
  db: Db,
  services: Services,
): Promise<CommandCtx> {
  // External content API: the token pins the workspace — the header cannot cross it
  // (IMPL-external-content-api §2.3). Membership is role-bound, not user-bound, so no
  // membership check either — same semantics as the MCP management plane.
  if (req.prinaApiToken && req.prinaActor) {
    return { db, workspaceId: req.prinaApiToken.workspaceId, actor: req.prinaActor, services };
  }
  const slug = (req.headers["x-prina-workspace"] as string | undefined) ?? "default";
  const workspaceId = await resolveWorkspaceId(db, slug);
  const actor: Actor =
    req.prinaActor ??
    // last-resort fallback for paths without auth-hooks registered (unit-test apps, etc.)
    parseActor(req.headers["x-prina-actor"] as string | undefined);
  await assertWorkspaceMembership(db, workspaceId, actor);
  return { db, workspaceId, actor, services };
}
