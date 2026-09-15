/** Global top bar (60px) — workspace switcher · theme toggle · user menu (design P3 top) */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlug, setWorkspaceSlug } from "../api/client";
import { useWorkspaces } from "../hooks/queries";
import { useTheme } from "../hooks/useTheme";
import { useAuth } from "../auth/AuthProvider";
import { IconSparkles } from "@tabler/icons-react";
import { AssistantPanel } from "../features/assistant/AssistantPanel";
import { ApiExplorerPanel } from "../features/api-explorer/ApiExplorerPanel";
import { IconApi } from "@tabler/icons-react";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const s = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return s.toUpperCase();
}

export function TopBar() {
  const [wsOpen, setWsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const { data: workspaces } = useWorkspaces();
  const { theme, setTheme } = useTheme();
  const { state, logout } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);
  // Personal pages are not assistant territory (06-IMPL-ai-assistant: dimmed rule)
  const assistantBlocked = location.pathname.startsWith("/settings/account");

  // Close on outside click / Escape (design interaction)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const host = (e.target as Element | null)?.closest?.("[data-pop]");
      const pop = host?.getAttribute("data-pop") ?? null;
      if (pop !== "ws") setWsOpen(false);
      if (pop !== "user") setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWsOpen(false);
        setUserOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const currentSlug = getWorkspaceSlug();
  const currentWs = workspaces?.find((w) => w.slug === currentSlug);
  const userName = state.status === "authed" ? state.me.user.name : "";

  return (
    <header className="topbar">
      <button
        data-pop="ws"
        className="ws-trigger"
        onClick={() => setWsOpen((v) => !v)}
      >
        <span className="ws-trigger-avatar">
          {initials(currentWs?.name ?? currentSlug)}
        </span>
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span className="ws-trigger-name">{currentWs?.name ?? currentSlug}</span>
          <span className="ws-trigger-meta">{currentSlug}</span>
        </span>
        <svg width="1.2rem" height="1.2rem" viewBox="0 0 12 12" fill="none" stroke="var(--text-3)" strokeWidth="1.6" style={{ marginLeft: "0.4rem" }}>
          <path d="M3 4.6 6 7.6 9 4.6" />
        </svg>
      </button>

      {wsOpen && (
        <div data-pop="ws" className="popover" style={{ left: "2rem", width: "30rem" }}>
          <div className="popover-label">Workspace · brand / country</div>
          {(workspaces ?? []).map((w) => (
            <button
              key={w.id}
              className={w.slug === currentSlug ? "popover-item active" : "popover-item"}
              onClick={() => {
                setWorkspaceSlug(w.slug);
                setWsOpen(false);
                void qc.invalidateQueries();
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <span style={{ fontSize: "1.3rem", fontWeight: 500 }}>{w.name}</span>
                <span style={{ fontSize: "1.1rem", color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
                  {w.slug}
                </span>
              </span>
              {w.slug === currentSlug && (
                <span style={{ width: "0.8rem", height: "0.8rem", borderRadius: "9.9rem", background: "var(--accent)" }} />
              )}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <button
        className={apiOpen ? "assistant-trigger open" : "assistant-trigger"}
        title="Content Delivery API — endpoints and testing"
        onClick={() => { setApiOpen((v) => !v); setAssistantOpen(false); }}
      >
        <IconApi size="1.6rem" /> API
      </button>

      <button
        className={assistantOpen ? "assistant-trigger open" : "assistant-trigger"}
        disabled={assistantBlocked}
        title={assistantBlocked ? "Not available on this page" : "AI assistant"}
        onClick={() => { setAssistantOpen((v) => !v); setApiOpen(false); }}
      >
        <IconSparkles size="1.6rem" /> AI
      </button>

      <div className="seg">
        <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
          Light
        </button>
        <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
          Dark
        </button>
      </div>

      <button
        data-pop="user"
        className="topbar-avatar"
        onClick={() => setUserOpen((v) => !v)}
      >
        {userName ? initials(userName) : "?"}
      </button>

      {userOpen && (
        <div data-pop="user" className="popover" style={{ right: "2rem", width: "22rem" }}>
          <div style={{ padding: "0.8rem 1rem 0.6rem" }}>
            <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{userName}</div>
            {state.status === "authed" && (
              <div style={{ fontSize: "1.05rem", color: "var(--text-3)", fontFamily: "var(--font-mono)", marginTop: "0.2rem" }}>
                {state.me.user.username}
              </div>
            )}
          </div>
          <button
            className="popover-item"
            onClick={() => {
              setUserOpen(false);
              navigate("/settings/account");
            }}
          >
            My account
          </button>
          <button className="popover-item" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      )}
      <AssistantPanel open={assistantOpen && !assistantBlocked} onClose={() => setAssistantOpen(false)} />
      <ApiExplorerPanel open={apiOpen} onClose={() => setApiOpen(false)} />
    </header>
  );
}
