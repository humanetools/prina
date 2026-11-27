/**
 * A token that is shown only once (2026-11-22) — one popup for access tokens, MCP tokens and SCIM
 * provisioning tokens. Done (or Escape / clicking outside) closes it; the token is not shown again.
 */
import type { ReactNode } from "react";
import { IconCopy } from "@tabler/icons-react";
import { copyText } from "../../hooks/clipboard";
import { Modal } from "./Modal";

export function IssuedTokenModal({
  token, hint, children, onDone,
}: {
  token: string;
  /** what to do with it — "Paste it into …" */
  hint: string;
  /** extra below the token (an example request) */
  children?: ReactNode;
  onDone(): void;
}) {
  return (
    <Modal title="Token issued — shown only now" onClose={onDone}>
      <p className="widget-hint" style={{ margin: 0 }}>{hint} You will not see it again.</p>
      <div className="token-once">
        <code className="mono">{token}</code>
        <button type="button" className="btn btn-sm" aria-label="Copy token" onClick={() => void copyText(token)}>
          <IconCopy size="1.4rem" />
        </button>
      </div>
      {children}
      <div className="row-gap" style={{ justifyContent: "flex-end", marginTop: "var(--space-4)" }}>
        <button type="button" className="btn btn-primary" autoFocus onClick={onDone}>Done</button>
      </div>
    </Modal>
  );
}
