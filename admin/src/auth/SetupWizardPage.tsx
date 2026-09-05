/**
 * Setup wizard (P1, §3.4 · design: Prina Install.dc.html) — step rail + one card per step.
 * The server owns progress: stepIndex is derived from /api/setup/status, so the flow is
 * forward-only and the single CTA dispatches whatever the current step commits.
 */
import { useEffect, useState } from "react";
import { api, apiErrorMessage } from "../api/client";
import type { SetupState } from "../api/types";
import { branding } from "../branding";
import { BrandLogo } from "../components/common/BrandLogo";
import { IntroScreen } from "./IntroScreen";
import { useAuth } from "./AuthProvider";
import { TunnelSetupCard } from "./TunnelSetupCard";

const STEPS = [
  { key: "adminCreated", label: "Admin account", hint: "owner of this instance", title: "Who owns this instance?" },
  { key: "workspaceConfigured", label: "Workspace", hint: "name it", title: "Name the workspace" },
  { key: "localesConfigured", label: "Locale", hint: "languages", title: "Pick the languages" },
  { key: "completed", label: "Connect", hint: "optional — AI assistant", title: "Connect an AI assistant" },
] as const;

/** Locale picker candidates (BCP 47) — codes outside the list are entered via Custom */
const COMMON_LOCALES: Array<[string, string]> = [
  ["ko", "Korean"], ["en", "English"], ["ja", "Japanese"],
  ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
  ["de", "German"], ["fr", "French"], ["es", "Spanish"],
  ["pt-BR", "Portuguese (Brazil)"], ["it", "Italian"], ["ru", "Russian"],
  ["vi", "Vietnamese"], ["th", "Thai"], ["id", "Indonesian"],
  ["ar", "Arabic"], ["hi", "Hindi"], ["nl", "Dutch"], ["pl", "Polish"],
  ["tr", "Turkish"], ["sv", "Swedish"],
];

const PW_GRADES = ["Weak", "Fair", "Good", "Strong"] as const;
const PW_COLORS = ["var(--danger)", "var(--review)", "var(--approved)", "var(--published)"] as const;

/** Login identifier — must match core's usernameSchema (modules/auth/username.ts).
 *  A local install's first account is an admin, not a mailing-list entry; the work email
 *  is asked for later, only when a public address is claimed. */
const usernameOk = (v: string) => /^[a-z0-9][a-z0-9._-]{1,31}$/.test(v.trim().toLowerCase());

/** 0–4, mirroring the design's meter: length, extra length, mixed case+digits, symbol */
function pwScore(p: string): number {
  if (!p) return 0;
  let n = 0;
  if (p.length >= 8) n++;
  if (p.length >= 12) n++;
  if (/[0-9]/.test(p) && /[a-z]/i.test(p)) n++;
  if (/[^A-Za-z0-9]/.test(p)) n++;
  return Math.min(n, 4);
}

export function SetupWizardPage() {
  const { refresh } = useAuth();
  /** Not persisted — the intro plays on every load until the admin account exists */
  const [introDone, setIntroDone] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", name: "", wsName: "" });
  /** Content languages, in pick order — the first one is the default entries start in */
  const [contentLocales, setContentLocales] = useState<string[]>(["en"]);
  /** Set when the user jumps back to a finished step; null = follow the server's position */
  const [viewStep, setViewStep] = useState<number | null>(null);
  /** The last step's MCP setup unfolds only after asking */
  const [mcpOptIn, setMcpOptIn] = useState(false);
  const [tunnelHost, setTunnelHost] = useState<string | null>(null);

  const load = () => api<SetupState>("/api/setup/status").then(setState);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The intro plays before the first step only. Rendered ahead of the state fetch so the
  // animation starts immediately instead of after a "Loading…" flash.
  if (!introDone && !state?.adminCreated) {
    return <IntroScreen onStart={() => setIntroDone(true)} />;
  }

  if (!state) return <div className="center-screen">Loading…</div>;

  /** How far the server says we have got — the furthest step the user may open */
  const serverStep = !state.adminCreated
    ? 0
    : !state.workspaceConfigured
      ? 1
      : !state.localesConfigured
        ? 2
        : 3;
  const stepIndex = viewStep !== null && viewStep <= serverStep ? viewStep : serverStep;
  /**
   * Step 0 is the one finished step that cannot be reopened: setupAdmin rejects a second
   * instance administrator (409), so re-submitting it could never succeed.
   */
  // No way back once installed — guardCompleted() rejects resubmission
  const canRevisit = (i: number) => i > 0 && i < serverStep && !state.completed;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      // A revisited step is committed — hand control back to the server's position
      setViewStep(null);
    } catch (e) {
      setError(apiErrorMessage(e, "Request failed"));
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const localeName = (code: string) => COMMON_LOCALES.find(([c]) => c === code)?.[1] ?? code;
  const score = pwScore(form.password);
  const usernameBad = form.username.length > 1 && !usernameOk(form.username);

  /** What still blocks the CTA on this step — also the disabled reason shown next to it */
  const blockReason = (): string | null => {
    if (stepIndex === 0) {
      if (!form.name.trim()) return "Enter the administrator's name";
      if (!usernameOk(form.username)) return "Pick an ID (2-32 chars: a-z, 0-9, . _ -)";
      if (form.password.length < 8) return "Password needs 8 characters or more";
      return null;
    }
    if (stepIndex === 1) return form.wsName.trim() ? null : "Name the workspace";
    if (stepIndex === 2) {
      return contentLocales.length === 0 ? "Pick at least one content language" : null;
    }
    return null;
  };
  const blocked = blockReason();

  const submit = () => {
    if (blocked) return;
    if (stepIndex === 0) {
      return void run(() =>
        api("/api/setup/admin", {
          method: "POST",
          body: { username: form.username, password: form.password, name: form.name },
        }),
      );
    }
    if (stepIndex === 1) {
      return void run(() =>
        api("/api/setup/workspace", { method: "POST", body: { name: form.wsName } }),
      );
    }
    if (stepIndex === 2) {
      // Pick order is the contract: the first language is the default
      const locales = contentLocales.map((code, i) => ({
        code,
        name: localeName(code),
        isDefault: i === 0,
      }));
      // Finish the install here to open the server gate — if the next step's MCP
      // connection got blocked by a 409, "verify the connection and finish" could
      // never be satisfied.
      // No refresh() on purpose: opening the gate and advancing the screen are
      // separate — refreshing here flips AuthProvider to authed and the wizard vanishes.
      return void run(async () => {
        await api("/api/setup/locales", { method: "POST", body: { locales } });
        await api("/api/setup/complete", { method: "POST" });
      });
    }
    // The last step makes no server call — the install is done; only the screen moves on
    return void refresh();
  };

  return (
    <div className="setup-shell">
      <aside className="setup-rail">
        <div className="setup-brand">
          <BrandLogo size="5.2rem" />
          <span className="setup-brand-word">{branding.name}</span>
        </div>
        <h1 className="setup-rail-title">Set up this instance</h1>

        <div className="setup-steps">
          {STEPS.map((s, i) => {
            const done = i < serverStep;
            const current = i === stepIndex;
            const revisit = canRevisit(i);
            const cls = `setup-step${done ? " done" : ""}${current ? " current" : ""}`;
            const inner = (
              <>
                <span className="setup-step-dot">{done ? "✓" : i + 1}</span>
                <span className="setup-step-label">{s.label}</span>
                {current && <span className="setup-step-hint">{s.hint}</span>}
              </>
            );
            return revisit ? (
              <button
                key={s.key} type="button" className={`${cls} revisit`}
                onClick={() => setViewStep(i)}
                title={`Back to ${s.label}`}
              >
                {inner}
              </button>
            ) : (
              <div key={s.key} className={cls}>{inner}</div>
            );
          })}
        </div>
      </aside>

      <main className="setup-main">
        <div className="setup-counter">
          <span>{String(stepIndex + 1).padStart(2, "0")}</span>
          <b>/ {String(STEPS.length).padStart(2, "0")}</b>
        </div>

        {/* key remounts the panel so the step-in animation replays on every step */}
        <div className="setup-body" key={stepIndex}>
          <h2>{STEPS[stepIndex]!.title}</h2>

          {stepIndex === 2 && (
            <>
              <div className="setup-card">
                <h3 className="setup-section-title">Admin interface language</h3>
                <div className="locale-grid">
                  <span className="locale-card on">
                    <span className="locale-num">1</span>
                    <span className="locale-card-text">
                      <span className="locale-card-name">English</span>
                      <span className="locale-card-code">en</span>
                    </span>
                  </span>
                </div>
              </div>

              <div className="setup-card">
                <h3 className="setup-section-title">Content languages to publish</h3>
                <div className="locale-grid">
                  {COMMON_LOCALES.map(([code, name]) => {
                    const order = contentLocales.indexOf(code);
                    const on = order >= 0;
                    return (
                      <label key={code} className={on ? "locale-card on" : "locale-card"}>
                        <input
                          type="checkbox" checked={on}
                          onChange={() =>
                            setContentLocales((cs) =>
                              on ? cs.filter((c) => c !== code) : [...cs, code],
                            )
                          }
                        />
                        <span className="locale-num">{on ? order + 1 : ""}</span>
                        <span className="locale-card-text">
                          <span className="locale-card-name">{name}</span>
                          <span className="locale-card-code">{code}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {stepIndex !== 2 && (
          <div className="setup-card">
            {stepIndex === 0 && (
              <>
                <label className="field">
                  <span>Full name</span>
                  <input value={form.name} onChange={set("name")} placeholder="Jane Park" />
                </label>
                <label className="field">
                  <span>ID</span>
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
                    placeholder="jane"
                    autoComplete="username"
                  />
                  {usernameBad && (
                    <span style={{ fontSize: "1.25rem", color: "var(--danger)" }}>
                      2-32 characters: lowercase letters, digits, dot, underscore or hyphen
                    </span>
                  )}
                </label>
                <label className="field">
                  <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    Password
                    {score > 0 && (
                      <span className="pw-grade" style={{ color: PW_COLORS[score - 1] }}>
                        {PW_GRADES[score - 1]}
                      </span>
                    )}
                  </span>
                  <input
                    type="password" value={form.password} onChange={set("password")}
                    placeholder="At least 8 characters"
                  />
                  <span className="pw-meter">
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i} className="pw-tick"
                        style={i < score ? { background: PW_COLORS[score - 1] } : undefined}
                      />
                    ))}
                  </span>
                </label>
              </>
            )}

            {stepIndex === 1 && (
              <label className="field">
                <span>Workspace name</span>
                <input value={form.wsName} onChange={set("wsName")} placeholder="Northwind Studio" />
              </label>
            )}

            {stepIndex === 3 && (
              <>
                <div className="setup-ready">
                  <BrandLogo size="4.4rem" />
                  <div>
                    <div className="setup-ready-title">Instance ready</div>
                    <div className="mono" style={{ color: "var(--text-3)" }}>
                      Setup complete — this last step is optional
                    </div>
                  </div>
                </div>
                <dl>
                  <div className="setup-summary-row">
                    <dt>Administrator</dt>
                    <dd>{form.name || "—"}{form.username ? `  ·  ${form.username}` : ""}</dd>
                  </div>
                  <div className="setup-summary-row">
                    <dt>Workspace</dt>
                    <dd>{form.wsName || "—"}</dd>
                  </div>
                  <div className="setup-summary-row">
                    <dt>Content languages</dt>
                    <dd>{contentLocales.map(localeName).join(", ") || "—"}</dd>
                  </div>
                </dl>
                {/* Ask first, then unfold — nothing MCP-related shows before the checkbox.
                    Connection guidance appends inside the same card once provisioning ends. */}
                <div className="setup-card">
                  <label className="tn-offer">
                    <input
                      type="checkbox" checked={mcpOptIn}
                      onChange={() => setMcpOptIn((v) => !v)}
                    />
                    <span>
                      <span className="tn-offer-title">Get a public address for AI assistants</span>
                      <span className="tn-offer-desc">
                        Prina is an MCP server, so an assistant can read and edit your content
                        directly — but hosted assistants (Claude, ChatGPT) reach you from their
                        own servers and cannot see <code>localhost</code>. <b>This step gives you
                        a public address</b> on <code>prina.app</code>, free for a year; the
                        assistant is connected afterwards with the URL it produces. Skip it if
                        this instance already has a public domain, or do it later from
                        MCP console › Agents.
                      </span>
                    </span>
                  </label>

                  {mcpOptIn && <TunnelSetupCard onReady={setTunnelHost} />}
                </div>
              </>
            )}
          </div>
          )}

          {error && <div className="form-error" style={{ marginTop: "1.4rem" }}>{error}</div>}

          <div className="setup-actions">
            <button className="btn btn-primary" disabled={busy || !!blocked} onClick={submit}>
              {stepIndex === 3 ? `Open ${branding.name}` : "Continue"}
            </button>
            {blocked && <span className="setup-block-msg">{blocked}</span>}
          </div>
        </div>
      </main>
    </div>
  );
}
