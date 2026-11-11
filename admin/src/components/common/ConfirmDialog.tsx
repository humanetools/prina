/**
 * In-app confirm dialog — replaces window.confirm(), whose OK/Cancel buttons follow the browser's language
 * (Korean on a Korean Windows) while the admin is English (2026-11-10).
 * Usage: `if (!(await confirmDialog("Delete 'x'?"))) return;` — <ConfirmHost /> is mounted once at the root.
 */
import { useEffect, useState } from "react";
import { Modal } from "./Modal";

interface Request {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve(ok: boolean): void;
}

let push: ((r: Request) => void) | null = null;

export function confirmDialog(
  message: string,
  opts: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const req: Request = { message, confirmLabel: opts.confirmLabel ?? "OK", danger: opts.danger ?? false, resolve };
    if (push) push(req);
    else resolve(window.confirm(message)); // host not mounted (should not happen) — fall back
  });
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    return () => { push = null; };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const close = (ok: boolean) => {
    current.resolve(ok);
    setQueue((q) => q.slice(1));
  };
  return (
    <Modal title="Confirm" onClose={() => close(false)}>
      <p style={{ margin: "0 0 var(--space-4)", whiteSpace: "pre-wrap" }}>{current.message}</p>
      <div className="row-gap" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => close(false)}>Cancel</button>
        <button
          className={current.danger ? "btn btn-danger" : "btn btn-primary"}
          autoFocus
          onClick={() => close(true)}
        >
          {current.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
