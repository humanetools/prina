/**
 * Root page — what a person sees when they open the instance address in a browser.
 *
 * The public address only exposes MCP, OAuth and discovery, so the root used to answer a
 * bare 404. That reads as "broken" to the one person most likely to try it: the owner,
 * following the "Open your address" button in their own provisioning email. This page
 * confirms the address works and points at the two things they actually need — the MCP URL
 * to paste into an assistant, and where the admin lives.
 *
 * It states no secrets: the hostname is already known to whoever loaded it, and the admin
 * location is either localhost (useless to a stranger) or a path Cloudflare Access guards.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { readTunnelState } from "../../modules/tunnel/service.js";

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hostOf = (req: FastifyRequest): string =>
  (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "";

const page = (host: string, mcpUrl: string, adminHere: boolean, localPort: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Prina</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#666;--line:#ebebeb;--soft:#fafafa}
@media(prefers-color-scheme:dark){:root{--bg:#000;--fg:#ededed;--muted:#a1a1a1;--line:#242424;--soft:#111}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:48px 24px;background:var(--bg);color:var(--fg);
font-family:"Geist","Noto Sans KR",system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:480px;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.02em}
p{margin:0;font-size:14px;line-height:1.6;color:var(--muted)}
.label{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.box{padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--soft);
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.row{display:flex;flex-direction:column;gap:6px}
a{color:inherit}
</style></head><body>
<div class="card">
  <div class="row"><h1>Prina is running here</h1>
  <p>This address is a content hub that AI assistants can read and edit through MCP.</p></div>
  <div class="row"><span class="label">MCP URL — paste into your assistant</span>
    <div class="box">${esc(mcpUrl)}</div></div>
  <div class="row"><span class="label">Admin</span>
    ${adminHere
      ? `<div class="box"><a href="/admin/">https://${esc(host)}/admin/</a></div>
         <p>Opening it asks for a one-time code by email before you reach Prina.</p>`
      : `<div class="box">http://localhost:${localPort}/admin</div>
         <p>The admin stays on the machine running this install — it is not reachable from here.</p>`}
  </div>
</div></body></html>`;

export function registerRootRoute(app: FastifyInstance, db: Db, localPort: number): void {
  app.get("/", async (req, reply) => {
    const host = hostOf(req);
    const state = await readTunnelState(db);
    // Only claim the admin is reachable here when it actually is (Access-gated)
    const adminHere = !!state?.remoteAdmin && !!state.host && host.startsWith(state.host);
    const proto =
      (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? req.protocol;
    return reply
      .type("text/html; charset=utf-8")
      .send(page(host, `${proto}://${host}/mcp/management`, adminHere, localPort));
  });
}
