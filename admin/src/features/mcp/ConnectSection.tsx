/**
 * MCP console › Connect — the URLs you paste into an assistant (management) or give an agent (delivery).
 * Hosted assistants need this instance on a public HTTPS domain; on localhost only desktop/IDE clients reach it.
 */
import { useState } from "react";
import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { api, apiErrorMessage, getWorkspaceSlug } from "../../api/client";
import { useInvalidatingMutation, useWorkspaces } from "../../hooks/queries";

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

  const base = window.location.origin;
  // With more than one workspace the address names the one in use (48-IMPL) — the plain address is the primary workspace
  const { data: workspaces } = useWorkspaces();
  const wsPath = (workspaces?.length ?? 0) > 1 ? `/${getWorkspaceSlug()}` : "";
  // Hosted assistants call in from their own servers — a localhost address only works for desktop and IDE clients
  const isLocal = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  const reachNote = isLocal
    ? "This address only works for desktop and IDE clients — hosted assistants call in from their own servers and cannot reach localhost."
    : "";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connect</h1>
          <span className="muted">
            Two doors, one protocol: assistants that write content, and agents that read it.
          </span>
        </div>
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
        <CopyField value={`${base}/mcp/management${wsPath}`} />

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
        <CopyField value={`${base}/mcp/delivery${wsPath}`} />

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
    </>
  );
}
