/** Asset commands (T4.1~T4.3) — shared by Media Library UI and MCP */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, count, desc, eq, ilike, sql } from "drizzle-orm";
import { AssetStatus, PermissionAction, SystemSubject } from "@prina/shared";
import { assets, assetUsages, contentTypes, entries } from "../../db/schema/index.js";
import { defineCommand } from "../../commands/define.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { CommandCtx } from "../../commands/context.js";
import { DEFAULT_RENDITIONS } from "../../storage/index.js";
import { extractImageMeta, METADATA_READ_BYTES } from "./metadata.js";
import { ANALYSIS_READ_BYTES, tryAnalyzeImage } from "./analysis.js";

const mediaPermission = (action: string) => () => ({
  action,
  subject: SystemSubject.Media,
});

const folderSchema = z
  .string()
  .regex(/^\/([a-zA-Z0-9_\-가-힣 ]+(\/[a-zA-Z0-9_\-가-힣 ]+)*)?$/, "Folder path format: /a/b")
  .default("/");

async function getAssetScoped(ctx: CommandCtx, id: string) {
  const [row] = await ctx.db
    .select()
    .from(assets)
    .where(and(eq(assets.workspaceId, ctx.workspaceId), eq(assets.id, id)))
    .limit(1);
  if (!row) throw new NotFoundError(`Asset ${id} not found`);
  return row;
}

/** Rendition URL set — null when imgproxy is not configured (original only) */
function renditionUrls(ctx: CommandCtx, storageKey: string, mime: string) {
  const signer = ctx.services.storage.imgproxy;
  if (!signer || !mime.startsWith("image/")) return null;
  return Object.fromEntries(
    DEFAULT_RENDITIONS.map((p) => [p.name, signer.renditionUrl(storageKey, p)]),
  );
}

/** ① Upload request — issue presigned URL (T4.1) */
export const assetRequestUpload = defineCommand({
  name: "asset.request_upload",
  resource: "asset",
  input: z.object({
    filename: z.string().min(1).max(255),
    mime: z.string().min(1).max(150),
    size: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
    folder: folderSchema,
  }),
  permission: mediaPermission(PermissionAction.Create),
  async execute(input, ctx) {
    const safeName = input.filename.replace(/[^a-zA-Z0-9._\-가-힣]/g, "_");
    const storageKey = `${ctx.workspaceId}/${randomUUID()}/${safeName}`;
    const [asset] = await ctx.db
      .insert(assets)
      .values({
        workspaceId: ctx.workspaceId,
        folder: input.folder,
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        storageKey,
        status: AssetStatus.Uploading,
        createdBy: ctx.actor.type === "human" ? (ctx.actor.id ?? null) : null,
      })
      .returning();
    const upload = await ctx.services.storage.adapter.presignUpload(
      storageKey,
      input.mime,
    );
    return { asset: asset!, upload };
  },
  resourceId: (_i, o) => o.asset.id,
  auditPayload: (i) => ({ filename: i.filename, mime: i.mime, size: i.size }),
});

/** ② Upload confirm — verify existence + extract dimensions/EXIF (T4.1) */
export const assetConfirmUpload = defineCommand({
  name: "asset.confirm_upload",
  resource: "asset",
  input: z.object({ id: z.string().uuid() }),
  permission: mediaPermission(PermissionAction.Create),
  async execute(input, ctx) {
    const asset = await getAssetScoped(ctx, input.id);
    const adapter = ctx.services.storage.adapter;
    const head = await adapter.head(asset.storageKey);
    if (!head) {
      throw new ValidationError("The uploaded file is not in storage — finish the upload first");
    }

    let width: number | null = null;
    let height: number | null = null;
    let metadata: Record<string, unknown> = {};
    if (asset.mime.startsWith("image/")) {
      // Full read (≤32MB) so the contrast analysis can decode pixels; larger files fall back
      // to the header-only metadata read (dimensions/EXIF live at the file start)
      const fullRead = head.size <= ANALYSIS_READ_BYTES;
      const buf = await adapter.read(
        asset.storageKey,
        fullRead ? ANALYSIS_READ_BYTES : METADATA_READ_BYTES,
      );
      if (buf) {
        const meta = await extractImageMeta(buf);
        width = meta.width;
        height = meta.height;
        // Composed, never overwritten — analysis (§0.11 4b) rides beside the EXIF whitelist
        const analysis = fullRead ? await tryAnalyzeImage(buf) : null;
        metadata = analysis ? { ...meta.exif, analysis } : meta.exif;
      }
    }

    const [updated] = await ctx.db
      .update(assets)
      .set({
        size: head.size,
        width,
        height,
        metadata,
        status: AssetStatus.Ready,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id))
      .returning();
    return updated!;
  },
  resourceId: (i) => i.id,
  auditPayload: (_i, o) => ({ filename: o.filename, size: o.size }),
});

/** List — folder/search filters + usage counts (T4.4) */
export const assetList = defineCommand({
  name: "asset.list",
  resource: "asset",
  skipAudit: true,
  input: z.object({
    folder: z.string().optional(),
    search: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(40),
  }),
  permission: mediaPermission(PermissionAction.Read),
  async execute(input, ctx) {
    const conds = [
      eq(assets.workspaceId, ctx.workspaceId),
      eq(assets.status, AssetStatus.Ready),
    ];
    if (input.folder) conds.push(eq(assets.folder, input.folder));
    if (input.search) conds.push(ilike(assets.filename, `%${input.search}%`));
    const where = and(...conds);

    const totalRows = await ctx.db.select({ value: count() }).from(assets).where(where);
    // drizzle strips qualifiers off outer-table columns inside subqueries, so fully qualify via raw SQL
    const rows = await ctx.db
      .select({
        asset: assets,
        usageCount: sql<number>`(select count(*)::int from asset_usages au where au.asset_id = assets.id)`,
      })
      .from(assets)
      .where(where)
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);

    const items = await Promise.all(
      rows.map(async ({ asset, usageCount }) => ({
        ...asset,
        usageCount: Number(usageCount),
        renditions: renditionUrls(ctx, asset.storageKey, asset.mime),
        downloadUrl: await ctx.services.storage.adapter.downloadUrl(asset.storageKey),
      })),
    );
    return {
      items,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: totalRows[0]?.value ?? 0,
      },
    };
  },
});

/** Folder list (T4.4 folder tree) */
export const assetFolders = defineCommand({
  name: "asset.folders",
  resource: "asset",
  skipAudit: true,
  input: z.object({}).default({}),
  permission: mediaPermission(PermissionAction.Read),
  async execute(_input, ctx) {
    const rows = await ctx.db
      .selectDistinct({ folder: assets.folder })
      .from(assets)
      .where(eq(assets.workspaceId, ctx.workspaceId))
      .orderBy(asc(assets.folder));
    return rows.map((r) => r.folder);
  },
});

/** Detail — renditions + usage list (T4.3/T4.4) */
export const assetGet = defineCommand({
  name: "asset.get",
  resource: "asset",
  skipAudit: true,
  input: z.object({ id: z.string().uuid() }),
  permission: mediaPermission(PermissionAction.Read),
  async execute(input, ctx) {
    const asset = await getAssetScoped(ctx, input.id);
    const usages = await ctx.db
      .select({
        entryId: assetUsages.entryId,
        field: assetUsages.field,
        typeUid: contentTypes.uid,
        typeName: contentTypes.name,
        entryValues: entries.values,
        locale: entries.locale,
      })
      .from(assetUsages)
      .innerJoin(entries, eq(assetUsages.entryId, entries.id))
      .innerJoin(contentTypes, eq(entries.contentTypeId, contentTypes.id))
      .where(eq(assetUsages.assetId, asset.id));

    return {
      ...asset,
      usages,
      deletable: usages.length === 0,
      renditions: renditionUrls(ctx, asset.storageKey, asset.mime),
      downloadUrl: await ctx.services.storage.adapter.downloadUrl(asset.storageKey),
    };
  },
});

/**
 * Contrast analysis backfill (§0.11 4b) — same code path as confirm, for assets uploaded
 * before the feature (or after a failed/oversized confirm-time analysis). Idempotent:
 * re-running just recomputes and re-merges metadata.analysis.
 */
export const assetAnalyze = defineCommand({
  name: "asset.analyze",
  resource: "asset",
  input: z.object({ id: z.string().uuid() }),
  permission: mediaPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const asset = await getAssetScoped(ctx, input.id);
    if (!asset.mime.startsWith("image/")) {
      throw new ValidationError("Only images can be analyzed");
    }
    const buf = await ctx.services.storage.adapter.read(asset.storageKey, ANALYSIS_READ_BYTES);
    if (!buf) throw new ValidationError("Asset file is not in storage");
    const analysis = await tryAnalyzeImage(buf);
    if (!analysis) {
      throw new ValidationError(
        "Analysis unavailable — image could not be decoded (or sharp is missing on this platform)",
      );
    }
    const [updated] = await ctx.db
      .update(assets)
      .set({ metadata: { ...asset.metadata, analysis }, updatedAt: new Date() })
      .where(eq(assets.id, asset.id))
      .returning();
    return updated!;
  },
  resourceId: (i) => i.id,
  auditPayload: (_i, o) => ({ filename: o.filename }),
});

/**
 * Update editable asset metadata — currently alt text only (a11y, WCAG 1.1.1).
 * Alt lives on the asset, so one edit applies to every usage including richtext embeds.
 */
export const assetUpdate = defineCommand({
  name: "asset.update",
  resource: "asset",
  input: z.object({
    id: z.string().uuid(),
    /** null = not described yet; "" = intentionally decorative (alt="") */
    alt: z.string().max(1000).nullable(),
  }),
  permission: mediaPermission(PermissionAction.Update),
  async execute(input, ctx) {
    const asset = await getAssetScoped(ctx, input.id);
    const [updated] = await ctx.db
      .update(assets)
      .set({ alt: input.alt, updatedAt: new Date() })
      .where(eq(assets.id, asset.id))
      .returning();
    return updated!;
  },
  resourceId: (i) => i.id,
  auditPayload: (i) => ({ described: i.alt !== null && i.alt.length > 0 }),
});

/** Delete — refused while in use (T4.3 DoD) */
export const assetDelete = defineCommand({
  name: "asset.delete",
  resource: "asset",
  input: z.object({ id: z.string().uuid() }),
  permission: mediaPermission(PermissionAction.Delete),
  async execute(input, ctx) {
    const asset = await getAssetScoped(ctx, input.id);
    const usageRows = await ctx.db
      .select({ value: count() })
      .from(assetUsages)
      .where(eq(assetUsages.assetId, asset.id));
    const usageCount = usageRows[0]?.value ?? 0;
    if (usageCount > 0) {
      throw new ConflictError(
        `Assets in use cannot be deleted (used in ${usageCount} place(s)) — remove the references first`,
      );
    }
    await ctx.db.delete(assets).where(eq(assets.id, asset.id));
    await ctx.services.storage.adapter.delete(asset.storageKey);
    return { id: asset.id, filename: asset.filename };
  },
  resourceId: (i) => i.id,
  auditPayload: (_i, o) => ({ filename: o.filename }),
});
