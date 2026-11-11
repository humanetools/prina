/**
 * Richtext (ProseMirror doc JSON) → HTML string (32-IMPL) — for the Liquid `richtext_to_html` filter.
 * The tags come from the schema's own `toDOM` specs, rendered without a DOM: one definition of the
 * markup, shared with the admin editor. Only text and attribute values are escaped — the tags the
 * schema produces are the point.
 */
import { Node, type Mark, type DOMOutputSpec } from "prosemirror-model";
import { richtextSchema } from "./schema.js";

const VOID_TAGS = new Set(["img", "br", "hr"]);

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Render a DOMOutputSpec array — [tag, attrs?, ...children] where a child of 0 is the content hole */
function renderSpec(spec: DOMOutputSpec, inner: string): string {
  if (typeof spec === "string") return escapeHtml(spec);
  if (!Array.isArray(spec)) return inner; // DOM node specs never occur here (no DOM)
  const [tag, ...rest] = spec as [string, ...unknown[]];
  let attrs: Record<string, unknown> = {};
  if (rest.length && rest[0] !== null && typeof rest[0] === "object" && !Array.isArray(rest[0])) {
    attrs = rest.shift() as Record<string, unknown>;
  }
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeHtml(String(v))}"`)
    .join("");
  if (VOID_TAGS.has(tag)) return `<${tag}${attrText}>`;
  const body = rest.map((c) => (c === 0 ? inner : renderSpec(c as DOMOutputSpec, inner))).join("");
  return `<${tag}${attrText}>${body}</${tag}>`;
}

function wrapMarks(marks: readonly Mark[], text: string): string {
  // marks[0] ends up outermost — same nesting the editor's DOMSerializer produces
  return [...marks].reverse().reduce((acc, mark) => renderSpec(mark.type.spec.toDOM!(mark, true), acc), text);
}

function renderNode(node: Node, assetUrl: (id: string) => string): string {
  if (node.isText) return wrapMarks(node.marks, escapeHtml(node.text ?? ""));
  const inner = renderChildren(node, assetUrl);
  if (node.type.name === "image") {
    const assetId = node.attrs.assetId as string | null;
    const src = assetId ? assetUrl(assetId) : (node.attrs.src as string | null);
    if (!src) return "";
    return renderSpec(["img", { src, alt: node.attrs.alt ?? "" }], "");
  }
  const spec = node.type.spec.toDOM?.(node);
  return spec === undefined ? inner : renderSpec(spec, inner); // doc has no toDOM — its children are the output
}

function renderChildren(node: Node, assetUrl: (id: string) => string): string {
  let out = "";
  node.forEach((child) => { out += renderNode(child, assetUrl); });
  return out;
}

const deliveryAssetUrl = (id: string) => `/delivery/assets/${id}`;

/** HTML for a richtext value; "" for null/invalid (a broken field must not take the whole render down) */
export function richtextToHtml(value: unknown, assetUrl: (id: string) => string = deliveryAssetUrl): string {
  if (value === null || value === undefined) return "";
  try {
    const doc = Node.fromJSON(richtextSchema, value);
    doc.check();
    return renderNode(doc, assetUrl);
  } catch {
    return "";
  }
}
