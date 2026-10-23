/** License status query command (T8.2) — for display in admin Settings › System */
import { z } from "zod";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { defineCommand } from "../../commands/define.js";
import { getLicenseState } from "./service.js";

export const licenseStatusGet = defineCommand({
  name: "license.status",
  resource: "license",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: () => ({ action: PermissionAction.Read, subject: SystemSubject.Settings }),
  async execute(_input, ctx) {
    const state = await getLicenseState(ctx.db);
    // Before the worker's first tick, no verdict yet — return null, distinct from unlicensed
    return { state };
  },
});
