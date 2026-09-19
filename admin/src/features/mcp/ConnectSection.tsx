/**
 * MCP console › Connect — the URL you paste into an assistant, and the public address behind it.
 *
 * Onboarding shows this once and then it is gone, so this is where it lives afterwards:
 * the effective MCP URL, whether the public address is up, and the way to get one if the
 * user skipped that step (the onboarding copy promises exactly that — "later from MCP console").
 */
import { useState } from "react";
import { IconCheck, IconCopy, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { api, apiErrorMessage } from "../../api/client";
import { useInvalidatingMutation, useTunnelStatus } from "../../hooks/queries";
import { TunnelSetupCard } from "../../auth/TunnelSetupCard";

/** Same list as the onboarding card — marks live in public/brand/assistants (lobe-icons, MIT) */
const ASSISTANTS = [
  { name: "Claude", icon: "claude", url: "https://claude.ai/settings/connectors" },
  { name: "ChatGPT", icon: "openai", url: "https://chatgpt.com/#settings/Connectors", mono: true },
  { name: "Perplexity", icon: "perplexity", url: "https://www.perplexity.ai/settings/connectors" },
  { name: "Gemini", icon: "gemini", url: "https://gemini.google.com/" },
];

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

export function ConnectSection() {
  const { data: tunnel, isLoading, refetch } = useTunnelStatus();
  const [showSetup, setShowSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);

  // Inline delivery-token issuance — same command as Agents · tokens, plane fixed to delivery
  const issueToken = useInvalidatingMutation(
    (name: string) =>
      api<{ token: string }>("/api/mcp/tokens", {
        method: "POST",
        body: { plane: "delivery", name },
      }),
    [["mcp-tokens"]],
  );
  const validAgentName = /^[a-z0-9][a-z0-9_-]{1,63}$/.test(agentName);

  const toggle = useInvalidatingMutation(
    (action: "enable" | "disable") => api(`/api/tunnel/${action}`, { method: "POST", body: {} }),
    [["tunnel-status"]],
  );

  const remoteAdmin = useInvalidatingMutation(
    (enabled: boolean) => api("/api/tunnel/remote-admin", { method: "POST", body: { enabled } }),
    [["tunnel-status"]],
  );

  const live = tunnel?.configured && tunnel.enabled && tunnel.running;
  // The public base is what a hosted assistant can actually reach; localhost only works for desktop clients
  const base = tunnel?.host ? `https://${tunnel.host}` : window.location.origin;
  const isPublic = !!tunnel?.host;
  const reachNote = isPublic
    ? "Hosted assistants reach this instance through your public address."
    : "This address only works for desktop and IDE clients — hosted assistants call in from their own servers and cannot reach localhost.";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connect</h1>
          <span className="muted">
            Two doors, one protocol: assistants that write content, and agents that read it.
          </span>
        </div>
        <button className="btn" onClick={() => void refetch()}>
          <IconRefresh size="1.5rem" /> Refresh
        </button>
      </div>

      {/* Management plane — authoring assistants (role-bound, signs in through Prina) */}
      <div className="mcp-connect">
        <div>
          <div className="mcp-connect-title">Author with AI · management</div>
          <p className="mcp-connect-sub">
            Add this URL in your assistant to create and edit content with it — it signs in
            through Prina (no key to copy) and works under your roles: drafts yes, publishing
            stays with people. {reachNote}
          </p>
        </div>
        <CopyField value={`${base}/mcp/management`} />

        <div className="tn-assistants">
          {ASSISTANTS.map((a) => (
            <a key={a.name} href={a.url} target="_blank" rel="noreferrer" className="tn-assistant">
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
      </div>

      {/* Delivery plane — content-serving agents (read-only, published entries only) */}
      <div className="mcp-connect" style={{ marginTop: "var(--space-4)" }}>
        <div>
          <div className="mcp-connect-title">Serve content to AI · delivery</div>
          <p className="mcp-connect-sub">
            Give this URL to agents that should read your content — a support chatbot, a
            partner's assistant. It is read-only and serves published entries only, so nothing
            in draft ever leaves.
          </p>
        </div>
        <CopyField value={`${base}/mcp/delivery`} />

        {/* Dedicated delivery token, issued right where the URL is copied */}
        <div className="tn-issue">
          <div className="mcp-connect-title" style={{ fontSize: "1.3rem" }}>Delivery token</div>
          {!issuedToken ? (
            <>
              <p className="mcp-connect-sub">
                Server-side agents cannot sign in — issue a read-only token here and put it in
                the agent's settings as a Bearer token, next to the URL above.
              </p>
              <div className="row-gap">
                <input
                  value={agentName}
                  placeholder="agent name, e.g. support-bot"
                  style={{ flex: 1, maxWidth: "32rem" }}
                  onChange={(e) => setAgentName(e.target.value.toLowerCase())}
                />
                <button
                  className="btn btn-primary"
                  disabled={!validAgentName || issueToken.isPending}
                  title={
                    agentName && !validAgentName
                      ? "Lowercase letters, digits, - and _ (2–64 chars)"
                      : undefined
                  }
                  onClick={() => {
                    setIssueError(null);
                    issueToken.mutate(agentName, {
                      onSuccess: (r) => {
                        setIssuedToken(r.token);
                        setAgentName("");
                      },
                      onError: (e) =>
                        setIssueError(apiErrorMessage(e, "Could not issue the token")),
                    });
                  }}
                >
                  {issueToken.isPending ? "Issuing…" : "Issue token"}
                </button>
              </div>
              {issueError && <p className="widget-hint danger">{issueError}</p>}
            </>
          ) : (
            <>
              <p className="mcp-connect-sub">
                Copy it now — this token is shown only once. Revoke it anytime in
                Agents · tokens.
              </p>
              <CopyField value={issuedToken} />
              <button className="btn btn-sm" onClick={() => setIssuedToken(null)}>
                Done
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Public address ─────────────────────────────── */}
      <div className="mcp-connect" style={{ marginTop: "var(--space-4)" }}>
        <div>
          <div className="mcp-connect-title">
            Public address
            {tunnel?.configured && (
              <span
                className={live ? "pill pill-published" : "pill pill-draft"}
                style={{ marginLeft: "var(--space-2)" }}
              >
                {!tunnel.enabled ? "Disabled" : live ? "Connected" : "Reconnecting"}
              </span>
            )}
          </div>
          <p className="mcp-connect-sub">
            A free <code>*.prina.app</code> address that lets hosted assistants reach this
            install.{" "}
            {tunnel?.remoteAdmin
              ? "Your admin is open on it too, behind a Cloudflare check."
              : "Only the MCP and sign-in endpoints are reachable from outside — your admin stays local."}
          </p>
        </div>

        {isLoading && <p className="widget-hint">Checking…</p>}

        {!isLoading && tunnel?.configured && (
          <>
            <div className="token-meta">
              <div className="token-meta-row">
                <span>address</span>
                <span className="mono">{tunnel.host}</span>
              </div>
              <div className="token-meta-row">
                <span>valid until</span>
                <span>
                  {tunnel.expiresAt ? new Date(tunnel.expiresAt).toISOString().slice(0, 10) : "—"}
                </span>
              </div>
              <div className="token-meta-row">
                <span>connector</span>
                <span>{tunnel.running ? "running" : "stopped"}</span>
              </div>
            </div>
            {tunnel.lastError && (
              <p className="widget-hint danger">
                Last connection problem: {tunnel.lastError}. The connector retries on its own;
                if it persists, an outbound firewall may be blocking it.
              </p>
            )}
            <div className="token-actions">
              <button
                className={tunnel.enabled ? "btn btn-danger" : "btn btn-primary"}
                disabled={toggle.isPending}
                onClick={() =>
                  toggle.mutate(tunnel.enabled ? "disable" : "enable", {
                    onError: (e) => setError(apiErrorMessage(e, "Could not change the address")),
                  })
                }
              >
                {tunnel.enabled ? "Stop the address" : "Start the address"}
              </button>
            </div>
            <p className="widget-hint">
              Stopping only shuts the connector down here — the address stays reserved.
              Unsubscribing from Prina emails ends it for good.
            </p>

            {/* Opening the admin changes the contract — say what changes before the switch */}
            <div className="tn-remote-admin">
              <label className="check">
                <input
                  type="checkbox"
                  checked={tunnel.remoteAdmin}
                  disabled={!tunnel.canToggleRemoteAdmin || remoteAdmin.isPending}
                  onChange={(e) =>
                    remoteAdmin.mutate(e.target.checked, {
                      onError: (err) =>
                        setError(apiErrorMessage(err, "Could not change remote admin access")),
                    })
                  }
                />
                <span>
                  <span className="tn-offer-title">Open the admin on this address too</span>
                  <span className="tn-offer-desc">
                    By default only the MCP and sign-in endpoints are reachable — your admin
                    stays on <code>localhost</code>. Turn this on and{" "}
                    <code>/admin</code> opens as well, behind a Cloudflare check: visitors must
                    enter a code emailed to <b>{tunnel.host ? "your verified address" : "you"}</b>{" "}
                    before they ever reach Prina. Your Prina password is still required after that.
                  </span>
                </span>
              </label>
              {!tunnel.canToggleRemoteAdmin && (
                <p className="widget-hint warn">
                  This address was issued before remote admin existed — claim a new address to use it.
                </p>
              )}
              {remoteAdmin.isPending && <p className="widget-hint">Applying…</p>}
            </div>
          </>
        )}

        {!isLoading && tunnel && !tunnel.configured && !showSetup && (
          <>
            {tunnel.cloudflaredAvailable ? (
              <button className="btn btn-primary" onClick={() => setShowSetup(true)}>
                Get a public address
              </button>
            ) : (
              <p className="widget-hint warn">
                This install cannot run the connector (cloudflared is not available), so a
                public address would not come up. The Docker image ships with it — or put
                Prina behind your own domain with TLS.
              </p>
            )}
          </>
        )}

        {showSetup && <TunnelSetupCard onReady={() => void refetch()} />}
        {error && <div className="form-error">{error}</div>}
      </div>
    </>
  );
}
