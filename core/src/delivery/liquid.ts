/**
 * Liquid render pipeline (T5.1) — sandboxed liquidjs execution.
 * - No filesystem access: templates come from the database. `{% render %}` resolves against the
 *   workspace's template partials (39-IMPL) through an in-memory fs adapter; include/layout stay off.
 * - Custom filters: won (KRW), date_ko, asset_url (asset id → URL), asset_alt, richtext_to_html (32-IMPL)
 * - Output size cap prevents runaway output. XSS is the template author's (developer role) responsibility —
 *   same trust boundary as the script.js lock (T5.3).
 */
import { Liquid } from "liquidjs";
import type { StorageServices } from "../storage/index.js";
import { ValidationError } from "../lib/errors.js";
import { richtextToHtml } from "../content/richtext/html.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * Partial renders per top-level render. A partial that renders itself (directly or through a
 * cycle) would otherwise recurse until the stack blows — liquidjs has no depth limit of its own.
 */
const MAX_PARTIAL_RENDERS = 500;

/** Partial sources by name — the caller picks the variant (published vs edit-marked) before rendering */
export type PartialSource = ReadonlyMap<string, string>;

export interface RenderInput {
  liquid: string;
  /** Render context: entry.values etc. */
  scope: Record<string, unknown>;
  storage: StorageServices;
  /** Template partials reachable through `{% render 'name' with value as blk %}` (39-IMPL) */
  partials?: PartialSource;
  /** Called once per partial name the render actually used — delivery attaches their script.js */
  onPartialUsed?: (name: string) => void;
}

const NO_PARTIALS: PartialSource = new Map();

/**
 * liquidjs fs adapter over the partial map. Names are opaque keys (`ds.hero`), so resolve() returns
 * the name untouched and the extension is empty. Every read is counted for the recursion guard.
 */
function partialFs(partials: PartialSource, onUsed?: (name: string) => void) {
  let reads = 0;
  const read = (name: string): string => {
    if (++reads > MAX_PARTIAL_RENDERS) {
      throw new Error(`Partial render limit exceeded (${MAX_PARTIAL_RENDERS}) — is a partial rendering itself?`);
    }
    const src = partials.get(name);
    if (src === undefined) throw new Error(`Unknown partial '${name}'`);
    onUsed?.(name);
    return src;
  };
  return {
    readFileSync: read,
    readFile: async (name: string) => read(name),
    // Always "exists": liquidjs would otherwise fail the lookup with a filesystem ENOENT before
    // reading — reporting through read() names the partial instead
    existsSync: () => true,
    exists: async () => true,
    resolve: (_root: string, name: string) => name,
    contains: async () => true,
    sep: "/",
    dirname: () => "",
    fallback: () => undefined,
  };
}

function createEngine(input: RenderInput): Liquid {
  const engine = new Liquid({
    // Undefined variables render empty (allows rendering incomplete draft entries — same completeness philosophy)
    strictVariables: false,
    strictFilters: true,
    relativeReference: false,
    // Partials (39-IMPL): names are database keys, resolved as-is; dynamic names let a page template
    // dispatch on the block's `__component` (`{% render blk.__component with blk as blk %}`)
    fs: partialFs(input.partials ?? NO_PARTIALS, input.onPartialUsed),
    extname: "",
    dynamicPartials: true,
    cache: false,
  });

  engine.registerFilter("won", (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    return `₩${n.toLocaleString("ko-KR")}`;
  });

  engine.registerFilter("date_ko", (v: unknown) => {
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  });

  // Asset value → access URL (S3=presigned, local=serving path). Accepts both media value
  // shapes: "uuid" and {id, alt} (§0.12). Async filter
  engine.registerFilter("asset_url", async (v: unknown) => {
    const id =
      typeof v === "string" ? v : ((v as { id?: string } | null)?.id ?? "");
    if (!id) return "";
    // Only the id is known (no storageKey), so use the delivery route's redirect path
    return `/delivery/assets/${id}`;
  });

  // Usage-level alt of a media value ({id, alt} shape); "" for bare uuids/absent overrides.
  // (Asset-level alt needs populate, which the html render path skips — todo 0.12 note.)
  engine.registerFilter("asset_alt", (v: unknown) => {
    if (v && typeof v === "object") {
      const alt = (v as { alt?: string | null }).alt;
      return typeof alt === "string" ? alt : "";
    }
    return "";
  });

  // Richtext (ProseMirror JSON) → HTML. `{{ values.body }}` alone prints [object Object] — the value is a
  // tree, not a string. Tags come from the schema; text is escaped; images resolve by asset id (32-IMPL).
  engine.registerFilter("richtext_to_html", (v: unknown) => richtextToHtml(v));

  void input.storage; // unused for now since asset_url redirects — keep the signature
  return engine;
}

export async function renderLiquid(input: RenderInput): Promise<string> {
  const engine = createEngine(input);
  let html: string;
  try {
    html = (await engine.parseAndRender(input.liquid, input.scope)) as string;
  } catch (e) {
    throw new ValidationError(
      `Template render error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (Buffer.byteLength(html) > MAX_OUTPUT_BYTES) {
    throw new ValidationError("Render output is too large (1MB limit)");
  }
  return html;
}
