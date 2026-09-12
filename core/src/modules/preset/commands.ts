/** Preset install commands (T7.2) — install = copy (components first, then the type) */
import { z } from "zod";
import { PermissionAction, SystemSubject } from "@prina/shared";
import { defineCommand } from "../../commands/define.js";
import { NotFoundError } from "../../lib/errors.js";
import { PRESETS } from "../../presets/catalog.js";
import { contentTypeCreate } from "../content-type/commands.js";
import { componentCreate } from "../content-type/component-commands.js";
import { findContentTypeByUid } from "../content-type/repo.js";
import { ConflictError } from "../../lib/errors.js";

export const presetList = defineCommand({
  name: "preset.list",
  resource: "preset",
  skipAudit: true,
  input: z.object({}).default({}),
  async execute() {
    return PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      uid: p.contentType.uid,
      schemaOrgType: p.contentType.schemaOrgType,
      fieldCount: p.contentType.definition.fields.length,
      // the gallery detail renders rule summaries (required, localized, etc.), so send the full definition
      fields: p.contentType.definition.fields,
      components: (p.components ?? []).map((c) => c.uid),
    }));
  },
});

export const presetInstall = defineCommand({
  name: "preset.install",
  resource: "preset",
  input: z.object({
    presetId: z.string().min(1),
    /** install under a different uid on uid conflict */
    uidOverride: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/).optional(),
  }),
  permission: () => ({
    action: PermissionAction.Create,
    subject: SystemSubject.ContentTypeBuilder,
  }),
  async execute(input, ctx) {
    const preset = PRESETS.find((p) => p.id === input.presetId);
    if (!preset) throw new NotFoundError(`Preset '${input.presetId}' not found`);
    const uid = input.uidOverride ?? preset.contentType.uid;
    if (await findContentTypeByUid(ctx.db, ctx.workspaceId, uid)) {
      throw new ConflictError(
        `Type '${uid}' already exists — pass uidOverride to install under another name`,
      );
    }

    for (const comp of preset.components ?? []) {
      try {
        await componentCreate.run(comp, ctx);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e; // reuse if it already exists
      }
    }
    // presets whose relation target is themselves (uid) get the override applied
    const definition = JSON.parse(
      JSON.stringify(preset.contentType.definition).replaceAll(
        `"target":"${preset.contentType.uid}"`,
        `"target":"${uid}"`,
      ),
    );
    const created = await contentTypeCreate.run(
      {
        uid,
        kind: preset.contentType.kind,
        name: preset.contentType.name,
        schemaOrgType: preset.contentType.schemaOrgType ?? undefined,
        definition,
      },
      ctx,
    );
    return { uid: created.uid, presetId: preset.id };
  },
  auditPayload: (i, o) => ({ presetId: i.presetId, uid: o.uid }),
});
