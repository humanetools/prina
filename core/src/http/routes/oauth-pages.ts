/**
 * OAuth sign-in / consent screens (design: Claude Design "Prina OAuth.dc.html").
 *
 * These are the only Prina screens a remote user sees before any content — and through a
 * public address they are the brand's first impression — so they carry the real design
 * tokens rather than the placeholder styling the endpoint shipped with.
 *
 * Self-contained on purpose: no admin bundle, no CSS build. The brand mark is inlined so
 * the page renders on API-only installs and behind the tunnel, where /admin is not exposed.
 * Plane selection and the role block are pure CSS (:checked siblings) — the page works with
 * scripting limited to the sign-in POST.
 */

export const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** design/brand/prina-mark-tile.svg — inlined; oklch stops render identically in both themes */
const MARK = `<svg viewBox="0 0 84 84" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" style="width:60px;height:60px;display:block"><defs><linearGradient id="as0" x1="0.3170" y1="0.1830" x2="0.6830" y2="0.8170"><stop offset="0%" stop-color="oklch(0.58 0.2 262)"/><stop offset="48%" stop-color="oklch(0.9 0.05 200)"/><stop offset="100%" stop-color="oklch(0.74 0.16 45)"/></linearGradient><linearGradient id="as1" x1="0.4251" y1="0.0749" x2="0.5749" y2="0.9251"><stop offset="0%" stop-color="oklch(0.96 0.03 220)"/><stop offset="55%" stop-color="oklch(0.56 0.21 266)"/><stop offset="100%" stop-color="oklch(0.88 0.06 180)"/></linearGradient><linearGradient id="as2" x1="0.3666" y1="0.1334" x2="0.6334" y2="0.8666"><stop offset="0%" stop-color="oklch(0.94 0.05 205)"/><stop offset="34%" stop-color="oklch(0.62 0.19 258)"/><stop offset="66%" stop-color="oklch(0.84 0.09 190)"/><stop offset="100%" stop-color="oklch(0.86 0.13 62)"/></linearGradient><radialGradient id="abg" cx="0.72" cy="0.08" r="1.05"><stop offset="0" stop-color="oklch(0.46 0.1 252)" stop-opacity="0.34"/><stop offset="0.6" stop-color="oklch(0.46 0.1 252)" stop-opacity="0"/></radialGradient><clipPath id="aclip"><rect width="84" height="84" rx="18.5"/></clipPath></defs><g clip-path="url(#aclip)"><rect width="84" height="84" rx="18.5" fill="oklch(0.145 0.012 264)"/><rect width="84" height="84" rx="18.5" fill="url(#abg)"/><g transform="translate(42 42) scale(0.54) translate(-42 -42)"><path d="M20.75 -0.97L21.62 -0.83L22.32 -0.30L22.76 0.53L22.86 1.53L19.89 41.18L19.63 42.23L19.05 43.11L18.25 43.69L17.35 43.88L3.80 43.62L2.98 43.40L2.32 42.81L1.91 41.94L1.83 40.92L4.98 2.67L5.23 1.68L5.76 0.81L6.51 0.21L7.36 -0.05Z" fill="url(#as0)" fill-opacity="0.8"/><path d="M42.73 8.15L43.74 8.33L44.57 8.93L45.09 9.87L45.22 10.99L41.76 63.70L41.48 64.88L40.82 65.85L39.89 66.47L38.84 66.64L21.38 65.56L20.42 65.27L19.66 64.58L19.18 63.58L19.08 62.43L22.84 11.96L23.11 10.86L23.72 9.91L24.57 9.25L25.54 8.99Z" fill="url(#as1)" fill-opacity="0.9"/><path d="M72.03 17.60L73.21 17.81L74.20 18.50L74.82 19.56L75.00 20.83L71.37 89.18L71.05 90.50L70.29 91.57L69.20 92.22L67.96 92.36L45.45 89.99L44.35 89.62L43.44 88.80L42.88 87.65L42.74 86.35L46.93 21.48L47.22 20.27L47.91 19.23L48.88 18.52L50.00 18.24Z" fill="url(#as2)" fill-opacity="1"/></g></g></svg>`;

/** Tokens copied from design/brand/tokens.css — light plus the dark overrides */
const STYLE = `
:root{--bg:oklch(0.965 0.003 264);--surface:oklch(1 0 0);--surface-2:oklch(0.982 0.002 264);--surface-3:oklch(0.955 0.004 264);--border:oklch(0.905 0.005 264);--border-strong:oklch(0.83 0.008 264);--text:oklch(0.26 0.012 264);--text-2:oklch(0.5 0.012 264);--text-3:oklch(0.64 0.01 264);--accent:oklch(0.635 0.185 258);--accent-hover:oklch(0.575 0.19 258);--accent-soft:oklch(0.962 0.038 258);--accent-on:oklch(1 0 0);--danger:oklch(0.56 0.11 22);--r-sm:5px;--r-pill:999px}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.175 0.006 264);--surface:oklch(0.225 0.007 264);--surface-2:oklch(0.252 0.008 264);--surface-3:oklch(0.285 0.009 264);--border:oklch(0.315 0.009 264);--border-strong:oklch(0.4 0.012 264);--text:oklch(0.945 0.004 264);--text-2:oklch(0.735 0.009 264);--text-3:oklch(0.6 0.01 264);--accent:oklch(0.7 0.13 258);--accent-hover:oklch(0.78 0.12 258);--accent-soft:oklch(0.305 0.06 258);--accent-on:oklch(0.17 0.02 258);--danger:oklch(0.72 0.16 22)}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:"Source Sans 3","Noto Sans KR",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;letter-spacing:-0.005em;display:grid;place-items:center;padding:48px 24px}
.shell{width:100%;max-width:396px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(16,20,32,0.04),0 14px 36px -20px rgba(16,20,32,0.24)}
.brand{padding:26px 32px 0;display:flex;align-items:center;justify-content:center;gap:11px}
.brand span{font-size:34px;font-weight:700;letter-spacing:-0.04em}
.body{padding:24px 32px 28px;display:flex;flex-direction:column;gap:20px;animation:stepIn .22s ease}
@keyframes stepIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-0.025em}
.head{display:flex;flex-direction:column;gap:9px}
.head-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.sub{font-size:13.5px;color:var(--text-2);line-height:1.5;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.desc{font-size:13.5px;line-height:1.5;color:var(--text-2)}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:var(--r-pill);background:var(--accent-soft);font-size:14px;font-weight:700;letter-spacing:-0.02em;color:var(--accent)}
.pill.sm{height:24px;padding:0 9px;font-size:12.5px;font-weight:650}
.pill i{width:5px;height:5px;border-radius:50%;background:var(--accent);display:block}
label.cap,.cap{font-size:11.5px;font-weight:650;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-3)}
.fields{display:flex;flex-direction:column;gap:18px}
.field{display:flex;flex-direction:column;gap:5px}
.field input{height:42px;width:100%;padding:0 2px;background:transparent;border:none;border-bottom:1.5px solid var(--border-strong);font:inherit;font-size:15px;color:var(--text);outline:none;border-radius:0}
.field input:focus{border-bottom-color:var(--accent)}
.err{display:none;margin-top:-8px;align-items:flex-start;gap:7px;font-size:12.5px;line-height:1.45;color:var(--danger)}
.err.on{display:flex}
.err svg{flex:none;margin-top:1px}
button.primary{width:100%;height:46px;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--r-sm);cursor:pointer;font:inherit;font-size:14.5px;font-weight:650}
button.primary:hover{background:var(--accent-hover)}
button.primary[disabled]{opacity:.7;cursor:default}
button.ghost{width:100%;height:46px;background:transparent;color:var(--text);border:1px solid var(--border-strong);border-radius:var(--r-sm);cursor:pointer;font:inherit;font-size:14.5px;font-weight:600}
button.ghost:hover{background:var(--surface-2)}
.acct{display:flex;align-items:center;gap:10px;padding:11px 13px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm)}
.acct .av{width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-on);display:grid;place-items:center;font-size:12px;font-weight:700;flex:none}
.acct .who{display:flex;flex-direction:column;gap:1px;min-width:0}
.acct .who b{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acct .who small{font-size:11.5px;color:var(--text-3)}
.acct form{margin-left:auto}
.acct button{background:none;border:none;padding:0;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;color:var(--accent)}
.group{display:flex;flex-direction:column;gap:9px}
.planes input{position:absolute;opacity:0;pointer-events:none}
.plane-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.plane{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px 13px;cursor:pointer;border-radius:var(--r-sm);background:var(--surface);border:1px solid var(--border-strong)}
.plane .top{display:flex;align-items:center;gap:8px}
.plane .dot{width:15px;height:15px;flex:none;border-radius:50%;display:block;border:1.5px solid var(--border-strong);background:var(--surface)}
.plane .name{font-size:13.5px;font-weight:650}
.plane .note{font-family:"Source Code Pro",ui-monospace,monospace;font-size:11.5px;color:var(--text-2)}
#p-mgmt:checked~.plane-grid label[for=p-mgmt],#p-dlv:checked~.plane-grid label[for=p-dlv]{background:var(--accent-soft);border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
#p-mgmt:checked~.plane-grid label[for=p-mgmt] .dot,#p-dlv:checked~.plane-grid label[for=p-dlv] .dot{border:4.5px solid var(--accent)}
#p-dlv:checked~.role{display:none}
.role{display:flex;flex-direction:column;gap:7px;margin-top:20px}
.role select{height:44px;width:100%;padding:0 12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-sm);font:inherit;font-size:14.5px;color:var(--text);outline:none;cursor:pointer}
.info{display:flex;flex-direction:column;gap:5px;padding:11px 13px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm)}
.info span:last-child{font-family:"Source Code Pro",ui-monospace,monospace;font-size:12px;color:var(--text-2);word-break:break-all}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.foot{display:flex;align-items:center;justify-content:center;gap:8px;font-family:"Source Code Pro",ui-monospace,monospace;font-size:11.5px;letter-spacing:0.04em;color:var(--text-3)}
`;

export interface ShellOptions {
  title: string;
  /** Shown in the footer — the address the client actually reached */
  host: string;
  body: string;
}

export function shell({ title, host, body }: ShellOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · Prina</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500&display=swap">
<style>${STYLE}</style></head><body>
<div class="shell">
  <div class="card">
    <div class="brand">${MARK}<span>Prina</span></div>
    ${body}
  </div>
  <div class="foot"><span>${esc(host)}</span><span>·</span><span>MCP OAuth</span></div>
</div></body></html>`;
}

const clientPill = (name: string, small = false) =>
  `<span class="pill${small ? " sm" : ""}"><i></i>${esc(name)}</span>`;

/** Sign-in — posts to the session endpoint, then reloads so the consent step renders */
export function signInBody(clientName: string): string {
  return `<div class="body">
  <div class="head">
    <h1>Sign in to Prina</h1>
    <div class="sub">${clientPill(clientName, true)}<span>is requesting access.</span></div>
  </div>
  <form class="fields" onsubmit="return login(event)">
    <div class="field"><label class="cap" for="em">ID</label>
      <input id="em" type="text" autocomplete="username" placeholder="your-id" required></div>
    <div class="field"><label class="cap" for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" placeholder="••••••••" required></div>
    <div class="err" id="err"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.4h0.01"/></svg><span id="errtext"></span></div>
    <button class="primary" id="go" type="submit">Sign in</button>
  </form>
</div>
<script>
async function login(e) {
  e.preventDefault();
  var go = document.getElementById("go"), err = document.getElementById("err");
  go.disabled = true; go.textContent = "Signing in…"; err.classList.remove("on");
  try {
    var r = await fetch("/api/auth/login", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: em.value, password: pw.value }) });
    if (r.ok) return location.reload();
    document.getElementById("errtext").textContent =
      r.status === 401 ? "Sign in failed — check credentials." : "Sign in failed (" + r.status + "). Try again.";
  } catch (_) {
    document.getElementById("errtext").textContent = "Could not reach this Prina instance.";
  }
  err.classList.add("on"); go.disabled = false; go.textContent = "Sign in";
  return false;
}
</script>`;
}

export interface ConsentOptions {
  clientName: string;
  host: string;
  /** Signed-in user — shown so the wrong account is caught before granting access */
  username: string;
  userName: string;
  redirectUri: string;
  roles: Array<{ id: string; name: string }>;
  defaultPlane: string;
  /** Hidden form fields carried through the POST (client_id, code_challenge, state …) */
  hidden: Record<string, string | undefined>;
}

const initialsOf = (name: string, username: string): string => {
  const source = name.trim() || username || "P";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "P") + (parts[1]?.[0] ?? "")).toUpperCase();
};

export function consentBody(o: ConsentOptions): string {
  const hidden = Object.entries(o.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? "")}">`)
    .join("");
  const isDelivery = o.defaultPlane === "delivery";
  return `<div class="body">
  <div class="head">
    <div class="head-row"><h1>Authorize</h1>${clientPill(o.clientName)}</div>
    <div class="desc">The client will act on this Prina instance with the access you choose.
      Every action is recorded in the audit log as AI activity.</div>
  </div>

  <div class="acct">
    <div class="av">${esc(initialsOf(o.userName, o.username))}</div>
    <div class="who"><b>${esc(o.userName || o.username)}</b><small>${esc(o.username)} · ${esc(o.host)}</small></div>
    <form method="post" action="/oauth/authorize" onsubmit="return switchUser(event)">
      <button type="submit">Switch</button>
    </form>
  </div>

  <form method="post" action="/oauth/authorize">
    ${hidden}
    <div class="group planes">
      <div class="cap">Access plane</div>
      <input type="radio" name="plane" value="management" id="p-mgmt"${isDelivery ? "" : " checked"}>
      <input type="radio" name="plane" value="delivery" id="p-dlv"${isDelivery ? " checked" : ""}>
      <div class="plane-grid">
        <label class="plane" for="p-mgmt">
          <span class="top"><span class="dot"></span><span class="name">Management</span></span>
          <span class="note">read + write via role</span>
        </label>
        <label class="plane" for="p-dlv">
          <span class="top"><span class="dot"></span><span class="name">Delivery</span></span>
          <span class="note">read-only, published</span>
        </label>
      </div>
      <div class="role">
        <label class="cap" for="role">Role (management)</label>
        <select id="role" name="role_id">
          ${o.roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}
        </select>
        <span class="desc">${esc(o.clientName)} acts with exactly this role's permissions — no more.</span>
      </div>
    </div>

    <div class="info" style="margin-top:20px">
      <span class="cap">Redirects to</span><span>${esc(o.redirectUri)}</span>
    </div>

    <div class="actions" style="margin-top:20px">
      <button class="ghost" type="submit" name="decision" value="deny">Deny</button>
      <button class="primary" type="submit" name="decision" value="approve">Allow access</button>
    </div>
  </form>
</div>
<script>
async function switchUser(e) {
  e.preventDefault();
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch (_) {}
  location.reload();
  return false;
}
</script>`;
}
