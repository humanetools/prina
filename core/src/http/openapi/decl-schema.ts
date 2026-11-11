/** Operation declarations — content types, components, schema.org lookups, presets, locales, taxonomies */
import {
  contentTypeCreate,
  contentTypeUpdate,
} from "../../modules/content-type/commands.js";
import { componentCreate, componentUpdate } from "../../modules/content-type/component-commands.js";
import {
  contentTypeFolderCreate,
  contentTypeFolderRename,
} from "../../modules/content-type/folder-commands.js";
import {
  componentFolderCreate,
  componentFolderRename,
} from "../../modules/content-type/component-folder-commands.js";
import { presetInstall } from "../../modules/preset/commands.js";
import { localeCreate, localeUpdate } from "../../modules/locale/commands.js";
import {
  taxonomyCreate,
  taxonomyNodeCreate,
  taxonomyNodeMove,
  taxonomyNodeUpdate,
  taxonomyUpdate,
} from "../../modules/taxonomy/commands.js";
import type { OpDecl } from "./types.js";

const CT = "content-types";
const DEF = { definition: "definition" };
const CMP = "components";
const LOC = "locales";
const TAX = "taxonomies";

export const SCHEMA_OPS: OpDecl[] = [
  { method: "GET", path: "/api/content-types", tag: CT, summary: "List content types", returns: "Array of content types (uid, name, kind, definition, schema.org mapping, …)" },
  {
    method: "POST", path: "/api/content-types", tag: CT, summary: "Create a content type", input: contentTypeCreate.input, bodyRefs: DEF, require: ["definition"], status: 201,
    description: "`definition.fields[]` is the schema — each field has a `type` from the field registry. Relations, components and dynamic zones are fields too.",
    returns: "The created content type (409 when the uid exists)",
  },
  { method: "GET", path: "/api/content-types/:uid", tag: CT, summary: "Get one content type", returns: "The content type with its full definition" },
  {
    method: "PUT", path: "/api/content-types/:uid", tag: CT, summary: "Update a content type", input: contentTypeUpdate.input, bodyRefs: DEF,
    description: "Send the fields you want to change; `definition` is replaced as a whole when present.",
    returns: "The updated content type",
  },
  { method: "DELETE", path: "/api/content-types/:uid", tag: CT, summary: "Delete a content type", returns: "{ id, uid }" },
  { method: "GET", path: "/api/content-types/:uid/jsonld-sample", tag: CT, summary: "JSON-LD sample built from the definition alone", returns: "{ jsonld }" },
  {
    method: "GET", path: "/api/content-types/folder-tree", tag: CT, summary: "Content-type folder tree (admin navigation)",
    query: [{ name: "kind", description: "`collection` or `single` — folders are kept per kind" }],
    description: "Flat and path-ordered (parents first) — assemble the tree from `parent`. `count` is the number of content types directly in the folder; a type's folder is its `folder` field (`/` = unfiled).",
    returns: "{ kind, items: [{ path, name, parent, count }], rootCount, total }",
  },
  {
    method: "POST", path: "/api/content-types/folders", tag: CT, summary: "Create a content-type folder", input: contentTypeFolderCreate.input, status: 201,
    description: "Missing ancestors are created too. 409 when the folder exists in that kind's tree.",
    returns: "{ kind, path }",
  },
  {
    method: "PATCH", path: "/api/content-types/folders", tag: CT, summary: "Rename or move a content-type folder", input: contentTypeFolderRename.input,
    description: "Rewrites the path of the folder, its subfolders and the `folder` of the content types inside. 409 when `newPath` exists, 422 when it lies inside `path`.",
    returns: "{ kind, path, previousPath, movedTypes }",
  },
  {
    method: "DELETE", path: "/api/content-types/folders", tag: CT, summary: "Delete an empty content-type folder",
    query: [{ name: "kind", description: "`collection` or `single`" }, { name: "path", description: "Folder path, e.g. `/shop/catalog`" }],
    description: "Only while no content type is filed in the folder or anywhere under it (409 otherwise). Empty subfolders are removed with it.",
    returns: "{ kind, path, removed[] }",
  },
  { method: "GET", path: "/api/schema-org/types", tag: CT, summary: "schema.org class list", returns: "{ types[] }" },
  { method: "GET", path: "/api/schema-org/properties", tag: CT, summary: "schema.org property list", returns: "{ properties[] }" },
  {
    method: "GET", path: "/api/schema-org/inverse", tag: CT, summary: "Standard inverse of a schema.org property",
    query: [{ name: "prop", description: "Property name, e.g. `author`" }], returns: "{ inverse: string | null }",
  },
  {
    method: "GET", path: "/api/schema-org/validate", tag: CT, summary: "Check properties against schema.org classes",
    query: [
      { name: "types", description: "Comma-separated class names" },
      { name: "props", description: "Comma-separated property names" },
    ],
    returns: "{ valid: Record<property, boolean> }",
  },
  { method: "GET", path: "/api/presets", tag: CT, summary: "List installable content type presets", returns: "Array of { id, name, description, … }" },
  { method: "POST", path: "/api/presets/:presetId/install", tag: CT, summary: "Install a preset as a new content type", input: presetInstall.input, status: 201, returns: "{ uid, presetId }" },

  { method: "GET", path: "/api/components", tag: CMP, summary: "List components", returns: "Array of components (uid, name, definition, options, markup, markupEnabled)",
    description: "`markupEnabled` says whether the component is a render unit (40-IMPL): `options.markup` when set, else true only if a partial already exists (legacy). `markup` is the current version of its partial — `{ version, hasCss, hasJs, updatedAt }` or null. The markup itself is read and written at /api/templates/partials/{uid}." },
  { method: "POST", path: "/api/components", tag: CMP, summary: "Create a component", input: componentCreate.input, bodyRefs: DEF, require: ["definition"], status: 201, returns: "The created component" },
  { method: "PUT", path: "/api/components/:uid", tag: CMP, summary: "Update a component (fields, name, options such as markup on/off)", input: componentUpdate.input, bodyRefs: DEF, returns: "The updated component",
    description: "`options` merges into the stored options. `{ \"options\": { \"markup\": true } }` turns the component's markup on; off makes its partial invisible to renders (a page that still renders it fails visibly)." },
  { method: "DELETE", path: "/api/components/:uid", tag: CMP, summary: "Delete a component", returns: "{ id, uid }" },
  // Component folders (42-IMPL) — same contract as content-type folders, one namespace
  {
    method: "GET", path: "/api/components/folder-tree", tag: CMP, summary: "Component folder tree (admin navigation)",
    description: "Flat and path-ordered (parents first) — assemble the tree from `parent`. `count` is the number of components directly in the folder; a component's folder is its `folder` field (`/` = unfiled).",
    returns: "{ items: [{ path, name, parent, count }], rootCount, total }",
  },
  {
    method: "POST", path: "/api/components/folders", tag: CMP, summary: "Create a component folder", input: componentFolderCreate.input, status: 201,
    description: "Missing ancestors are created too. 409 when the folder exists.", returns: "{ path }",
  },
  {
    method: "PATCH", path: "/api/components/folders", tag: CMP, summary: "Rename or move a component folder", input: componentFolderRename.input,
    description: "Rewrites the path of the folder, its subfolders and the `folder` of the components inside. 409 when `newPath` exists, 422 when it lies inside `path`.", returns: "{ path, previousPath, movedComponents }",
  },
  {
    method: "DELETE", path: "/api/components/folders", tag: CMP, summary: "Delete an empty component folder",
    query: [{ name: "path", description: "Folder path, e.g. /blocks/cards" }],
    description: "Only while no component is filed in the folder or anywhere under it (409 otherwise). Empty subfolders are removed with it.", returns: "{ path, removed[] }",
  },

  { method: "GET", path: "/api/locales", tag: LOC, summary: "List locales", returns: "Array of locales (code, name, isDefault, fallback, …)" },
  { method: "POST", path: "/api/locales", tag: LOC, summary: "Add a locale", input: localeCreate.input, status: 201, returns: "The created locale" },
  { method: "PATCH", path: "/api/locales/:code", tag: LOC, summary: "Update a locale", input: localeUpdate.input, returns: "The updated locale" },
  { method: "DELETE", path: "/api/locales/:code", tag: LOC, summary: "Remove a locale", returns: "{ code }", description: "The default locale cannot be removed (422); a locale that entries still use answers 409." },

  { method: "GET", path: "/api/taxonomies", tag: TAX, summary: "List taxonomies", returns: "Array of taxonomies" },
  { method: "POST", path: "/api/taxonomies", tag: TAX, summary: "Create a taxonomy", input: taxonomyCreate.input, status: 201, returns: "The created taxonomy", description: "`attributeFields` defines the attributes every node of this taxonomy carries values for: [{ name, label, type: text | number | boolean, multiline }]." },
  { method: "PATCH", path: "/api/taxonomies/:taxonomyUid", tag: TAX, summary: "Edit a taxonomy: name, description, attribute definitions", input: taxonomyUpdate.input, returns: "The updated taxonomy", description: "Removing an attribute field drops its values from every node." },
  {
    method: "DELETE", path: "/api/taxonomies/:taxonomyUid", tag: TAX, summary: "Delete a taxonomy and its whole tree",
    description: "Entry and asset attachments to its nodes are removed with it; the entries and assets themselves stay. Cannot be undone.",
    returns: "{ id, uid, name, nodes, entryAttachments, assetAttachments } — what was removed",
  },
  { method: "GET", path: "/api/taxonomies/:taxonomyUid/tree", tag: TAX, summary: "All nodes of a taxonomy", returns: "Array of nodes ordered by materialized `path`" },
  { method: "POST", path: "/api/taxonomies/:taxonomyUid/nodes", tag: TAX, summary: "Add a node", input: taxonomyNodeCreate.input, status: 201, returns: "The created node" },
  { method: "PATCH", path: "/api/taxonomy-nodes/:nodeId", tag: TAX, summary: "Edit a node: name, slug, attributes, entry component", input: taxonomyNodeUpdate.input, returns: "The updated node", description: "`attributes` replaces the node's attribute values as a whole (keys must be the taxonomy's attributeFields; unknown key or wrong type → 422). A new slug rewrites the path of the node and of every node under it; 409 when a sibling already has that path." },
  { method: "PUT", path: "/api/taxonomy-nodes/:nodeId/move", tag: TAX, summary: "Move a node (and its subtree)", input: taxonomyNodeMove.input, returns: "The moved node" },
  { method: "DELETE", path: "/api/taxonomy-nodes/:nodeId", tag: TAX, summary: "Delete a node", returns: "{ id, path }" },
];
