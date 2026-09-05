/**
 * Onboarding — provision a public address for this instance.
 *
 * What this card is NOT: the MCP connection itself. It only obtains an address; connecting the
 * assistant happens afterwards with the URL produced here. The wizard's checkbox says so too —
 * calling it "connect an assistant" made people expect a connection screen and file the
 * address flow as a bug.
 *
 * Rendered only after the user opts into MCP setup (the wizard owns that gate), so nothing
 * here is visible unless it was asked for. If the admin was opened on a public host, the card
 * leads with that address instead — nothing to provision.
 *
 * Why it exists: hosted assistants (Claude.ai, ChatGPT) fetch the MCP URL from their own
 * servers, so http://localhost is unreachable for them. A Prina-provided subdomain on
 * *.prina.app gives a local install something they can actually connect to.
 *
 * The address is free for a year in exchange for a work email and marketing consent — the two
 * are tied, so unsubscribing also ends the address. Flow: email+consent → 3-digit code →
 * pick a subdomain → create.
 *
 * `tunnelApi` talks to core's /api/tunnel/* relay — core holds the verify ticket and the
 * connector token; the browser only ever sees the resulting host.
 */
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { api, ApiError, apiErrorMessage } from "../api/client";

const ROOT_DOMAIN = "prina.app";
const TERM_MONTHS = 12;

/** Consumer mailboxes — the offer is aimed at companies evaluating Prina */
const FREE_MAIL = [
  "gmail.com", "googlemail.com", "naver.com", "hanmail.net", "daum.net", "kakao.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.jp",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com", "gmx.com",
  "mail.ru", "qq.com", "163.com", "126.com", "yandex.com", "zoho.com",
];
const RESERVED = [
  "www", "api", "app", "admin", "mail", "smtp", "imap", "ftp", "cdn", "static",
  "docs", "blog", "status", "help", "support", "dev", "staging", "test", "demo",
  "mcp", "oauth", "auth", "login", "prina", "console", "dashboard", "billing",
];
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

/**
 * Connector setup screens of the hosted assistants.
 * Marks live in public/brand/assistants (lobe-icons, MIT) — original brand colors.
 * Only OpenAI's mark is monochrome, so it inverts on the dark theme.
 * ⚠ Gemini's connector deep link needs verifying — it points at the app root for now.
 */
const ASSISTANTS = [
  { name: "Claude", icon: "claude", url: "https://claude.ai/settings/connectors" },
  // OpenAI's mark is monochrome by design — invert it to match the background (mono)
  { name: "ChatGPT", icon: "openai", url: "https://chatgpt.com/#settings/Connectors", mono: true },
  { name: "Perplexity", icon: "perplexity", url: "https://www.perplexity.ai/settings/connectors" },
  { name: "Gemini", icon: "gemini", url: "https://gemini.google.com/" },
];

/**
 * The tunnel service answers with a reason code (§9) and core relays it untouched, so the
 * failure the user sees should be that reason — not "something went wrong". Swallowing it
 * cost a real debugging session: TUNNEL_EXISTS ("this email already has an address") showed
 * up as a generic retry prompt, which reads like an outage.
 */
function tunnelErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) {
    return "Could not reach Prina. Check your network and try again.";
  }
  switch (e.code) {
    case "TUNNEL_EXISTS":
      return "This email already has an address. Manage it from MCP console › Connect, or use another work email.";
    case "WORK_EMAIL_REQUIRED":
      return "That is a personal mailbox — use your company address.";
    case "RATE_LIMITED":
      // The server distinguishes the two cases and sends the sentence (IP quota / 60s hammering)
      return e.message || "Too many attempts — wait a moment and try again.";
    case "SUBDOMAIN_TAKEN":
      return "That address is taken — try another.";
    case "TUNNEL_SERVICE_UNREACHABLE":
      return e.message;
    default:
      return apiErrorMessage(e, "Something went wrong. Try again.");
  }
}

/** A Prina address only matters when opened on localhost — a public host serves as-is. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"];
const isLocalHost = (h: string) => LOCAL_HOSTS.includes(h) || h.endsWith(".localhost");

const emailShape = (v: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim());
const domainOf = (v: string) => v.trim().split("@")[1]?.toLowerCase() ?? "";
const isWorkEmail = (v: string) => emailShape(v) && !FREE_MAIL.includes(domainOf(v));

const tunnelApi = {
  async sendCode(email: string): Promise<void> {
    await api("/api/tunnel/code", { method: "POST", body: { email, consent: true } });
  },
  async verifyCode(email: string, code: string): Promise<boolean> {
    try {
      await api("/api/tunnel/verify", { method: "POST", body: { email, code } });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false;
      throw e;
    }
  },
  async checkSubdomain(name: string): Promise<boolean> {
    const r = await api<{ available: boolean }>(
      `/api/tunnel/available?name=${encodeURIComponent(name)}`,
    );
    return r.available;
  },
  async create(email: string, name: string): Promise<{ host: string; expiresAt: number }> {
    return api("/api/tunnel/create", { method: "POST", body: { email, subdomain: name } });
  },
};

type Stage = "email" | "code" | "subdomain" | "done";

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="tn-copy">
      <code>{value}</code>
      <button
        type="button" className="btn btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <IconCheck size="1.4rem" /> : <IconCopy size="1.4rem" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function TunnelSetupCard({ onReady }: { onReady?(host: string): void }) {
  const [stage, setStage] = useState<Stage>("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [digits, setDigits] = useState(["", "", ""]);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join("");
  const [sub, setSub] = useState("");
  const [avail, setAvail] = useState<"idle" | "checking" | "free" | "taken" | "invalid">("idle");
  const [result, setResult] = useState<{ host: string; expiresAt: number } | null>(null);

  const emailOk = isWorkEmail(email);
  const emailTyped = email.trim().length > 3;
  const subTrimmed = sub.trim().toLowerCase();

  // Check availability when typing pauses — not on every keystroke
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!subTrimmed) return setAvail("idle");
    if (!SUBDOMAIN_RE.test(subTrimmed) || RESERVED.includes(subTrimmed)) return setAvail("invalid");
    setAvail("checking");
    timer.current = setTimeout(() => {
      void tunnelApi.checkSubdomain(subTrimmed).then((free) => setAvail(free ? "free" : "taken"));
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [subTrimmed]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(tunnelErrorMessage(e)); }
    finally { setBusy(false); }
  };

  // If this screen was opened on a public address there is nothing to provision — that
  // address already works. (Installs on fly or a custom domain land here. Provisioning
  // stays available; the card just states the fact.)
  const publicHost = typeof window !== "undefined" && !isLocalHost(window.location.hostname)
    ? window.location.host
    : null;

  return (
    <div className="tn-flow">
          {publicHost && (
            <section className="tn-step on">
              <div className="tn-step-head">
                <span className="tn-step-num ok"><IconCheck size="1.3rem" /></span>
                <span>You already have a public address</span>
              </div>
              <div className="tn-step-body">
                <span className="tn-hint">
                  This instance is already reachable at <b>{publicHost}</b>, so an assistant can
                  connect to it directly — a Prina address is only needed when Prina runs on{" "}
                  <code>localhost</code>. Point your assistant here:
                </span>
                <CopyField value={`https://${publicHost}/mcp/management`} />
                <span className="tn-hint">
                  You can still take a <code>.{ROOT_DOMAIN}</code> address below if you want a
                  shorter one, but nothing here is required.
                </span>
              </div>
            </section>
          )}

          {/* ── 1. Work email + consent ─────────────────────── */}
          <section className={stage === "email" ? "tn-step on" : "tn-step"}>
            <div className="tn-step-head">
              <span className="tn-step-num">{stage === "email" ? "1" : <IconCheck size="1.3rem" />}</span>
              <span>Work email</span>
            </div>
            {stage === "email" ? (
              <div className="tn-step-body">
                <label className="field">
                  <input
                    type="email" value={email} placeholder="you@company.com"
                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                    className={emailTyped && !emailOk ? "invalid" : undefined}
                  />
                  {emailTyped && !emailOk && (
                    <span className="tn-hint danger">
                      {emailShape(email)
                        ? `${domainOf(email)} is a personal mailbox — use your company address`
                        : "That does not look like an email address"}
                    </span>
                  )}
                </label>
                <label className="check">
                  <input type="checkbox" checked={consent} onChange={() => setConsent((v) => !v)} />
                  <span>Send me product news and offers from Prina</span>
                </label>
                <span className="tn-hint">
                  Required — the address is provided in exchange for this. It stays valid for up
                  to {TERM_MONTHS} months, and <b>unsubscribing ends the address too</b>.
                </span>
                <button
                  className="btn btn-primary" disabled={!emailOk || !consent || busy}
                  onClick={() => void run(async () => {
                    await tunnelApi.sendCode(email.trim());
                    setStage("code");
                  })}
                >
                  {busy ? "Sending…" : "Send verification code"}
                </button>
              </div>
            ) : (
              <div className="tn-step-done">{email}</div>
            )}
          </section>

          {/* ── 2. 3-digit code check ───────────────────────── */}
          {stage !== "email" && (
            <section className={stage === "code" ? "tn-step on" : "tn-step"}>
              <div className="tn-step-head">
                <span className="tn-step-num">{stage === "code" ? "2" : <IconCheck size="1.3rem" />}</span>
                <span>Verify</span>
              </div>
              {stage === "code" ? (
                <div className="tn-step-body">
                  <span className="tn-hint">We sent a 3-digit code to <b>{email}</b>.</span>
                  <div className="tn-code-row">
                    <div className="tn-code-boxes">
                      {[0, 1, 2].map((i) => (
                        <input
                          key={i} ref={(el) => { boxes.current[i] = el; }}
                          className="tn-code mono" inputMode="numeric" maxLength={1}
                          value={digits[i]}
                          onChange={(e) => {
                            const typed = e.target.value.replace(/\D/g, "");
                            setError(null);
                            if (!typed) return setDigits((d) => d.map((v, j) => (j === i ? "" : v)));
                            // A multi-digit paste fills the following boxes too
                            setDigits((d) => {
                              const next = [...d];
                              typed.split("").forEach((ch, k) => { if (i + k < 3) next[i + k] = ch; });
                              return next;
                            });
                            boxes.current[Math.min(i + typed.length, 2)]?.focus();
                          }}
                          onKeyDown={(e) => {
                            // Backspace on an empty box moves back — erase-and-retype must not break flow
                            if (e.key === "Backspace" && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
                          }}
                        />
                      ))}
                    </div>
                    <button
                      className="btn btn-primary" disabled={code.length !== 3 || busy}
                      onClick={() => void run(async () => {
                        const ok = await tunnelApi.verifyCode(email.trim(), code);
                        if (ok) setStage("subdomain");
                        else {
                          setError("That code is not right. Check the email and try again.");
                          setDigits(["", "", ""]);
                          boxes.current[0]?.focus();
                        }
                      })}
                    >
                      {busy ? "Checking…" : "Verify"}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm" disabled={busy}
                      onClick={() => void run(() => tunnelApi.sendCode(email.trim()))}
                    >
                      Resend
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tn-step-done">Verified</div>
              )}
            </section>
          )}

          {/* ── 3. Subdomain pick ───────────────────────────── */}
          {(stage === "subdomain" || stage === "done") && (
            <section className={stage === "subdomain" ? "tn-step on" : "tn-step"}>
              <div className="tn-step-head">
                <span className="tn-step-num">{stage === "subdomain" ? "3" : <IconCheck size="1.3rem" />}</span>
                <span>Choose an address</span>
              </div>
              {stage === "subdomain" ? (
                <div className="tn-step-body">
                  <div className="tn-sub-row">
                    <input
                      className={`mono${avail === "invalid" || avail === "taken" ? " invalid" : ""}`}
                      value={sub} placeholder="your-company"
                      onChange={(e) => setSub(e.target.value.toLowerCase())}
                    />
                    <span className="tn-sub-suffix mono">.{ROOT_DOMAIN}</span>
                  </div>
                  <span className={`tn-hint${avail === "taken" || avail === "invalid" ? " danger" : avail === "free" ? " ok" : ""}`}>
                    {avail === "idle" && "Lowercase letters, numbers and dashes. 2–32 characters."}
                    {avail === "checking" && "Checking availability…"}
                    {avail === "free" && `${subTrimmed}.${ROOT_DOMAIN} is available`}
                    {avail === "taken" && `${subTrimmed}.${ROOT_DOMAIN} is taken — try another`}
                    {avail === "invalid" && (RESERVED.includes(subTrimmed)
                      ? `'${subTrimmed}' is reserved`
                      : "Lowercase letters, numbers and dashes only, 2–32 characters")}
                  </span>
                  <button
                    className="btn btn-primary" disabled={avail !== "free" || busy}
                    onClick={() => void run(async () => {
                      const created = await tunnelApi.create(email.trim(), subTrimmed);
                      setResult(created);
                      setStage("done");
                      onReady?.(created.host);
                    })}
                  >
                    {busy ? "Creating…" : "Create address"}
                  </button>
                </div>
              ) : (
                <div className="tn-step-done mono">{result?.host}</div>
              )}
            </section>
          )}

          {/* ── 4. Done — the URL for MCP ────────────────────── */}
          {stage === "done" && result && (
            <section className="tn-step on tn-result">
              <div className="tn-step-head">
                <span className="tn-step-num ok"><IconCheck size="1.3rem" /></span>
                <span>Ready</span>
              </div>
              <div className="tn-step-body">
                <span className="tn-hint">Use this URL in your AI assistant:</span>
                <CopyField value={`https://${result.host}/mcp/management`} />
                <div className="tn-assistants">
                  {ASSISTANTS.map((a) => (
                    <a
                      key={a.name} href={a.url} target="_blank" rel="noreferrer"
                      className="tn-assistant"
                    >
                      <img
                        className={"mono" in a && a.mono ? "tn-assistant-logo mono" : "tn-assistant-logo"}
                        alt=""
                        src={`${import.meta.env.BASE_URL}brand/assistants/${a.icon}.svg`}
                      />
                      <span className="tn-assistant-name">{a.name}</span>
                      <IconExternalLink size="1.4rem" />
                    </a>
                  ))}
                </div>
                <span className="tn-hint">
                  Open your assistant's connector settings and add the URL above. It signs in
                  through Prina, so there is no key to copy.
                </span>
                <span className="tn-hint">
                  Valid until <b>{new Date(result.expiresAt).toISOString().slice(0, 10)}</b>, or
                  until you unsubscribe from Prina emails — the address ends with the
                  subscription. Only the MCP and sign-in endpoints are reachable from outside;
                  your admin stays local. You can open the admin on this address later from
                  MCP console › Connect — it is then protected by an emailed code before
                  anyone reaches Prina.
                </span>
              </div>
            </section>
          )}

      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
