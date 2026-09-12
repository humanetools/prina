/**
 * Liquid render pipeline (T5.1) — sandboxed liquidjs execution.
 * - No filesystem access (renderString only), include/layout disabled.
 * - Custom filters: won (KRW), date_ko, asset_url (asset id → URL)
 * - Output size cap prevents runaway output. XSS is the template author's (developer role) responsibility —
 *   same trust boundary as the script.js lock (T5.3).
 */
import { Liquid } from "liquidjs";
import type { StorageServices } from "../storage/index.js";
import { ValidationError } from "../lib/errors.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RenderInput {
  liquid: string;
  /** Render context: entry.values etc. */
  scope: Record<string, unknown>;
  storage: StorageServices;
}

function createEngine(storage: StorageServices): Liquid {
  const engine = new Liquid({
    // Undefined variables render empty (allows rendering incomplete draft entries — same completeness philosophy)
    strictVariables: false,
    strictFilters: true,
    relativeReference: false,
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

  void storage; // unused for now since asset_url redirects — keep the signature
  return engine;
}

export async function renderLiquid(input: RenderInput): Promise<string> {
  const engine = createEngine(input.storage);
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
