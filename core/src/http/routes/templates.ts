/** Template management REST adapter (T5.3/T5.4/T5.5) — command calls only */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PermissionAction, contentSubject } from "@prina/shared";
import type { Db } from "../../db/client.js";
import type { Services } from "../../commands/context.js";
import { buildCommandCtx } from "../request-context.js";
import { defineCommand } from "../../commands/define.js";
import {
  templateGet,
  templateRenderPreview,
  templateSave,
  templateSetCurrent,
} from "../../modules/template/commands.js";
import { issueDraftToken } from "../../modules/delivery/token.js";
import { workspaces } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

/** Draft token issuance (T5.5) — for holders of content read permission */
const draftTokenIssue = defineCommand({
  name: "delivery.issue_draft_token",
  resource: "delivery_token",
  input: z.object({
    expiresInHours: z.number().min(1).max(24 * 30).default(24),
  }),
  permission: () => ({ action: PermissionAction.Read, subject: contentSubject("*") }),
  async execute(input, ctx) {
    const [ws] = await ctx.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1);
    return issueDraftToken(ctx.db, ws!.slug, input.expiresInHours);
  },
  auditPayload: (i) => ({ expiresInHours: i.expiresInHours }),
});

export function registerTemplateRoutes(
  app: FastifyInstance,
  db: Db,
  services: Services,
): void {
  const ctx = (req: Parameters<typeof buildCommandCtx>[0]) =>
    buildCommandCtx(req, db, services);

  app.get("/api/templates/:typeUid", async (req) => {
    const { typeUid } = req.params as { typeUid: string };
    return templateGet.run({ typeUid }, await ctx(req));
  });
  app.put("/api/templates/:typeUid", async (req) => {
    const { typeUid } = req.params as { typeUid: string };
    return templateSave.run({ ...(req.body as object), typeUid }, await ctx(req));
  });
  app.post("/api/templates/:typeUid/versions/:version/activate", async (req) => {
    const params = req.params as { typeUid: string; version: string };
    return templateSetCurrent.run(
      { typeUid: params.typeUid, version: Number(params.version) },
      await ctx(req),
    );
  });
  app.post("/api/templates/:typeUid/preview", async (req) => {
    const { typeUid } = req.params as { typeUid: string };
    return templateRenderPreview.run({ ...(req.body as object), typeUid }, await ctx(req));
  });
  app.post("/api/delivery/draft-token", async (req) =>
    draftTokenIssue.run(req.body ?? {}, await ctx(req)),
  );
}
