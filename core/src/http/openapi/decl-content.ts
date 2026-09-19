/** Operation declarations — entries, publish, import, assets, templates */
import {
  entryCreate,
  entryList,
  entryUpdate,
} from "../../modules/entry/commands.js";
import { entryTransition } from "../../modules/entry/transition-commands.js";
import { entrySetSeo } from "../../modules/entry/seo.js";
import { entrySetTaxonomies } from "../../modules/entry/document-commands.js";
import { importExecute, importParse, importValidate } from "../../modules/import/commands.js";
import { assetList, assetRequestUpload, assetUpdate } from "../../modules/asset/commands.js";
import { assetFolderCreate, assetFolderRename } from "../../modules/asset/folder-commands.js";
import { assetSetTaxonomies } from "../../modules/asset/taxonomy-commands.js";
import { templateRenderPreview, templateSave } from "../../modules/template/commands.js";
import { draftTokenIssue } from "../routes/templates.js";
import type { OpDecl } from "./types.js";

const ENT = "content";
const IMP = "import";
const AST = "assets";
const TPL = "templates";

const FILTER_PARAM = {
  name: "filter[field]",
  description: "Exact-match value filter, repeatable (`filter[status_label]=final`). ANDed.",
};

export const CONTENT_OPS: OpDecl[] = [
  {
    method: "GET", path: "/api/content/:typeUid", tag: ENT, summary: "List entries", input: entryList.input, omit: ["filter"], query: [FILTER_PARAM], perType: true,
    description: "Drafts included — this is the management plane. For published-only reads use `/delivery/*`. Narrow by classification with `taxonomy=<taxonomyUid>:<node.path>` (same rule as `/delivery/*` and `/api/assets`), and ask for `include=taxonomies` to get every row's taxonomy nodes in this one call.",
    returns: "{ items[], pagination: { page, pageSize, total, pageCount } } — with `include=taxonomies` each item also carries taxonomies[]: { nodeId, name, path, taxonomy, attributeValues, attributeComponentUid }",
  },
  {
    method: "POST", path: "/api/content/:typeUid", tag: ENT, summary: "Create an entry", input: entryCreate.input, status: 201, perType: true,
    description: "Creates a draft. Pass `documentId` + `locale` to add a locale variant of an existing document.",
    returns: "The created entry (id, documentId, locale, status, values, …)",
  },
  {
    method: "GET", path: "/api/content/:typeUid/:id", tag: ENT, summary: "Get an entry", perType: true,
    returns: "{ entry, effectiveValues, completeness, advisories, variants[] }",
  },
  {
    method: "PUT", path: "/api/content/:typeUid/:id", tag: ENT, summary: "Update an entry", input: entryUpdate.input, perType: true,
    description: "`values` is merged into the stored values — send only the fields that change.",
    returns: "The updated entry",
  },
  { method: "DELETE", path: "/api/content/:typeUid/:id", tag: ENT, summary: "Delete an entry", perType: true, returns: "{ id }" },
  { method: "PUT", path: "/api/content/:typeUid/:id/seo", tag: ENT, summary: "Replace the entry's SEO record", input: entrySetSeo.input, returns: "{ entry, version }" },
  { method: "POST", path: "/api/content/:typeUid/:id/duplicate", tag: ENT, summary: "Duplicate an entry as a new draft", status: 201, returns: "The new entry" },
  {
    method: "GET", path: "/api/content/:typeUid/:id/traverse", tag: ENT, summary: "Walk the relation graph from an entry",
    query: [
      { name: "path", description: "Dot-separated relation chain, e.g. `series.brand`" },
      { name: "depth", description: "Expand every relation N hops (when `path` is not given)", schema: { type: "integer" } },
      { name: "published", description: "`1` = published targets only" },
    ],
    returns: "{ start, mode, depth, nodes[], edges[], targets[], truncated }",
  },
  { method: "GET", path: "/api/content/:typeUid/:id/jsonld-preview", tag: ENT, summary: "JSON-LD of an entry, drafts included", returns: "{ jsonld, status }" },
  { method: "GET", path: "/api/content/:typeUid/document/:documentId", tag: ENT, summary: "All locale variants of a document", returns: "Array of entries sharing the documentId" },
  { method: "PUT", path: "/api/content/:typeUid/:id/taxonomies", tag: ENT, summary: "Replace the entry's taxonomy attachments", input: entrySetTaxonomies.input, returns: "{ entryId, attached }" },
  {
    method: "GET", path: "/api/content/:typeUid/:id/versions", tag: ENT, summary: "Version history of an entry",
    description: "Present only on editions that include version history.", returns: "Array of versions (version, status, createdAt, actor, …)",
  },
  {
    method: "POST", path: "/api/content/:typeUid/:id/versions/:version/restore", tag: ENT, summary: "Restore a version as the current draft",
    description: "Present only on editions that include version history.", returns: "The restored entry",
  },
  {
    method: "POST", path: "/api/content/:typeUid/:id/transition", tag: "publish", summary: "Move an entry through the workflow (publish, unpublish, …)", input: entryTransition.input, perType: true,
    description: "`to` is an entry status (`draft`, `review`, `approved`, `published`); which moves are allowed depends on the workspace's workflow. A transition the workflow does not allow from the current state answers 422 and names the allowed targets in `error.message`; publishing with incomplete required fields answers 422 with `error.details.missing`.",
    returns: "{ entry, version, from, to }",
  },
  {
    method: "POST", path: "/api/delivery/draft-token", tag: ENT, summary: "Issue a delivery draft token", input: draftTokenIssue.input,
    description: "The token (`dt1…`) goes on `/delivery/*` requests as `?draft=` to include unpublished entries in previews.",
    returns: "{ token, expiresAt }",
  },

  { method: "POST", path: "/api/import/parse", tag: IMP, summary: "Parse an uploaded sheet (CSV / XLSX) into rows", input: importParse.input, returns: "{ sheetName, columns[], columnSamples, rows[], totalRows, truncated }" },
  { method: "POST", path: "/api/import/validate", tag: IMP, summary: "Validate mapped rows against a content type", input: importValidate.input, returns: "{ total, validCount, errors[] }" },
  { method: "POST", path: "/api/import/execute", tag: IMP, summary: "Create entries from mapped rows", input: importExecute.input, returns: "Bulk-create report (created ids, per-row errors)" },

  { method: "GET", path: "/api/assets", tag: AST, summary: "List assets", input: assetList.input, returns: "{ items[], pagination: { page, pageSize, total } }" },
  { method: "GET", path: "/api/assets/folders", tag: AST, summary: "List asset folders", description: "Plain paths — empty folders and ancestors included. For names, parents and counts use `/api/assets/folder-tree`.", returns: "Array of folder paths" },
  {
    method: "GET", path: "/api/assets/folder-tree", tag: AST, summary: "Asset folder tree",
    description: "Flat and path-ordered (parents first) — assemble the tree from `parent`. `count` is the number of assets directly in the folder.",
    returns: "{ items: [{ path, name, parent, count }], rootCount, total }",
  },
  {
    method: "POST", path: "/api/assets/folders", tag: AST, summary: "Create a folder", input: assetFolderCreate.input, status: 201,
    description: "Missing ancestors are created too (`/a/b/c` creates `/a` and `/a/b`). 409 when the folder exists.",
    returns: "{ path }",
  },
  {
    method: "PATCH", path: "/api/assets/folders", tag: AST, summary: "Rename or move a folder", input: assetFolderRename.input,
    description: "Rewrites the path of the folder, its subfolders and the assets inside. 409 when `newPath` exists, 422 when it lies inside `path`.",
    returns: "{ path, previousPath, movedAssets }",
  },
  {
    method: "DELETE", path: "/api/assets/folders", tag: AST, summary: "Delete an empty folder",
    query: [{ name: "path", description: "Folder path, e.g. `/products/2026`" }],
    description: "Only while no asset is filed in the folder or anywhere under it (409 otherwise). Empty subfolders are removed with it.",
    returns: "{ path, removed[] }",
  },
  {
    method: "POST", path: "/api/assets/uploads", tag: AST, summary: "Start an upload (step 1 of 3)", input: assetRequestUpload.input, status: 201,
    description: "Upload flow: ① this call returns the asset row and `upload` = { url, method, headers?, expiresIn } — a presigned target (a relative url means this host). ② Send the file bytes there with that method and those headers. ③ `POST /api/assets/{id}/confirm`. Until confirmed the asset is not usable in media fields.",
    returns: "{ asset, upload: { url, method, headers?, expiresIn } }",
  },
  { method: "POST", path: "/api/assets/:id/confirm", tag: AST, summary: "Confirm an upload (step 3 of 3)", returns: "The asset with dimensions / metadata filled in (422 when the file is not in storage yet)" },
  { method: "POST", path: "/api/assets/:id/analyze", tag: AST, summary: "Re-run image analysis (contrast, dominant colors)", returns: "The updated asset" },
  { method: "GET", path: "/api/assets/:id", tag: AST, summary: "Get an asset", returns: "The asset plus { usages[], taxonomies[], deletable, renditions, downloadUrl }" },
  { method: "PATCH", path: "/api/assets/:id", tag: AST, summary: "Update asset metadata — alt text, folder (move)", input: assetUpdate.input, returns: "The updated asset" },
  {
    method: "PUT", path: "/api/assets/:id/taxonomies", tag: AST, summary: "Replace the asset's taxonomy attachments", input: assetSetTaxonomies.input,
    description: "`nodeIds` is the full set — `[]` detaches everything. Assets share the taxonomies entries use; find assets by node with `GET /api/assets?taxonomy=`.",
    returns: "{ assetId, filename, taxonomies[] }",
  },
  { method: "DELETE", path: "/api/assets/:id", tag: AST, summary: "Delete an asset", description: "409 while entries still reference it.", returns: "{ id, filename }" },
  {
    method: "PUT", path: "/api/assets/local-upload", tag: AST, summary: "Presigned upload target of the local storage adapter (step 2 of 3)",
    description: "Exists only when the instance stores files locally (no S3). Do not build this URL yourself — use `upload.url` from step 1, which carries the signature.",
    query: [
      { name: "key", description: "Storage key (from `upload.url`)" },
      { name: "expires", description: "Expiry (from `upload.url`)" },
      { name: "sig", description: "HMAC signature (from `upload.url`)" },
    ],
    rawBody: { contentType: "application/octet-stream", description: "The file bytes" },
    returns: "{ ok, size }",
  },
  { method: "GET", path: "/api/assets/raw/:key", tag: AST, summary: "Original file (local storage adapter only)", returns: "The file bytes" },

  { method: "GET", path: "/api/templates/:typeUid", tag: TPL, summary: "Get the render template of a content type", returns: "{ current, versions[], canEditScript }" },
  { method: "PUT", path: "/api/templates/:typeUid", tag: TPL, summary: "Save the template as a new version", input: templateSave.input, returns: "The saved template version" },
  { method: "POST", path: "/api/templates/:typeUid/versions/:version/activate", tag: TPL, summary: "Make a saved version current", returns: "The activated version" },
  {
    method: "POST", path: "/api/templates/:typeUid/preview", tag: TPL, summary: "Render an entry with a (possibly unsaved) template", input: templateRenderPreview.input,
    description: "Stores nothing — a read for access purposes.", returns: "{ html, css, head, checks[] }",
  },
];
