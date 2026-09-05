/** workspace switcher (T3.1 — two-tier tenancy §3.3). Always visible globally */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconStack2 } from "@tabler/icons-react";
import { getWorkspaceSlug, setWorkspaceSlug } from "../api/client";
import { useWorkspaces } from "../hooks/queries";

export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  const { data: workspaces } = useWorkspaces();
  const qc = useQueryClient();
  const current = getWorkspaceSlug();
  const currentWs = workspaces?.find((w) => w.slug === current);

  return (
    <div className="ws-switcher">
      <button
        className="iconbar-logo"
        title={`Workspace: ${currentWs?.name ?? current}`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconStack2 size="2.2rem" stroke={1.6} />
      </button>
      {open && (
        <div className="ws-popover">
          <div className="ws-popover-title">Workspace</div>
          {(workspaces ?? []).map((w) => (
            <button
              key={w.id}
              className={w.slug === current ? "ws-item active" : "ws-item"}
              onClick={() => {
                setWorkspaceSlug(w.slug);
                setOpen(false);
                void qc.invalidateQueries();
              }}
            >
              <span>{w.name}</span>
              <code>{w.slug}</code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
