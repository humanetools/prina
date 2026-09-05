/**
 * Onboarding — connect an AI assistant over MCP (OAuth 2.1).
 *
 * Prina *is* the MCP server, so nothing is pasted back into Prina: the user adds this
 * instance's MCP URL in their client, and the client runs discovery → dynamic client
 * registration → consent → token against our OAuth endpoints. No token to copy by hand.
 *
 * Clients connect in two ways, and which one is usable depends on the address:
 *  - desktop/IDE clients read a config file and happily call http://localhost
 *  - hosted assistants (Claude, ChatGPT …) fetch the URL from their own servers, so they
 *    require public HTTPS
 * A fresh install is almost always http://localhost, so on plain HTTP we lead with the
 * desktop group and offer a tunnel recipe instead of dangling unusable buttons.
 */
import { useState } from "react";
import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react";

/** Hosted assistants that can add a custom MCP server from their own settings UI */
const HOSTED = [
  { name: "Claude", url: "https://claude.ai/settings/connectors", note: "Connectors › Add custom connector" },
  { name: "ChatGPT", url: "https://chatgpt.com/#settings/Connectors", note: "Connectors (Pro/Business)" },
  { name: "Le Chat", url: "https://chat.mistral.ai/", note: "Mistral — Connectors" },
  { name: "Perplexity", url: "https://www.perplexity.ai/settings/connectors", note: "Comet · desktop app" },
];

/** Clients configured through a JSON file — one snippet covers all of them */
const LOCAL_CLIENTS = [
  "Claude Desktop", "Cursor", "VS Code (Copilot)", "Windsurf",
  "Cline", "Zed", "Goose", "Continue", "JetBrains AI", "Gemini CLI",
];

export function McpConnectCard() {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp/management`;
  const [copied, setCopied] = useState<"url" | "config" | "tunnel" | null>(null);
  /** Hosted assistants call in from their servers — plain HTTP is rejected outright */
  const isHttps = window.location.protocol === "https:";

  const configSnippet = JSON.stringify({ mcpServers: { prina: { url: mcpUrl } } }, null, 2);
  const tunnelCmd = `cloudflared tunnel --url ${origin}`;
  const text = { url: mcpUrl, config: configSnippet, tunnel: tunnelCmd };

  const copy = (what: "url" | "config" | "tunnel") => {
    void navigator.clipboard.writeText(text[what]).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    });
  };
  const copyBtn = (what: "url" | "config" | "tunnel") => (
    <button type="button" className="btn btn-sm" onClick={() => copy(what)}>
      {copied === what ? <IconCheck size="1.4rem" /> : <IconCopy size="1.4rem" />}
      {copied === what ? "Copied" : "Copy"}
    </button>
  );

  const desktopGroup = (
    <div className="mcp-group" key="desktop">
      <span className="mcp-group-label">
        Desktop &amp; IDE clients — paste into the MCP config
        {!isHttps && <em className="mcp-group-tag">works on localhost</em>}
      </span>
      <div className="mcp-config-row">
        <pre className="mcp-config">{configSnippet}</pre>
        {copyBtn("config")}
      </div>
      <div className="mcp-chip-row">
        {LOCAL_CLIENTS.map((n) => (
          <span key={n} className="mcp-chip">{n}</span>
        ))}
      </div>
    </div>
  );

  const hostedGroup = (
    <div className={`mcp-group${isHttps ? "" : " muted"}`} key="hosted">
      <span className="mcp-group-label">
        Hosted assistants — open settings and add the URL
        {!isHttps && <em className="mcp-group-tag warn">needs public HTTPS</em>}
      </span>
      <div className="mcp-client-row">
        {HOSTED.map((c) => (
          <a key={c.name} className="mcp-client" href={c.url} target="_blank" rel="noreferrer noopener">
            <span className="mcp-client-name">
              {c.name} <IconExternalLink size="1.3rem" />
            </span>
            <span className="mcp-client-note">{c.note}</span>
          </a>
        ))}
      </div>
    </div>
  );

  return (
    <section className="mcp-connect">
      <div>
        <div className="mcp-connect-title">Connect an AI assistant</div>
        <p className="mcp-connect-sub">
          Prina is an MCP server — your assistant can read and edit content directly.
          Point a client at the URL below; it signs in through Prina (OAuth), so there is
          no key to copy.
        </p>
      </div>

      <div className="mcp-url-row">
        <code className="mcp-url">{mcpUrl}</code>
        {copyBtn("url")}
      </div>

      {/* On plain HTTP the desktop group is the one that actually works — lead with it */}
      {isHttps ? [hostedGroup, desktopGroup] : [desktopGroup, hostedGroup]}

      {!isHttps && (
        <div className="mcp-tunnel">
          <p>
            This instance runs on <code>{origin}</code>. Hosted assistants only accept
            public <strong>HTTPS</strong>, so use a desktop client now — or expose this
            instance temporarily to try Claude/ChatGPT today:
          </p>
          <div className="mcp-config-row">
            <pre className="mcp-config">{tunnelCmd}</pre>
            {copyBtn("tunnel")}
          </div>
          <p className="mcp-tunnel-note">
            The tunnel prints an <code>https://…</code> address — add <code>/mcp/management</code>
            to it in the assistant. For production, put Prina behind your own domain with TLS.
          </p>
        </div>
      )}

      <p className="mcp-connect-skip">
        Other assistants (Gemini, Qwen, DeepSeek, Kimi …) are adding MCP support at their own
        pace — when yours does, the same URL is all it needs. You can skip this and connect
        later from MCP console › Agents.
      </p>
    </section>
  );
}
