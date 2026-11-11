/**
 * Global admin AI assistant (06-IMPL-ai-assistant) — chat panel over POST /api/ai/assistant.
 * The server runs a tool loop over commands (drafts only); irreversible actions arrive as
 * proposal cards executed here by the human through the normal REST endpoints, so
 * "AI up to draft, humans publish" holds by construction.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { IconCheck, IconEraser, IconRobot, IconSend, IconX } from "@tabler/icons-react";
import { api, ApiError, getWorkspaceSlug } from "../../api/client";

interface TraceItem {
  tool: string;
  ok: boolean;
  error?: string;
}
type Proposal =
  | { kind: "transition"; typeUid: string; entryId: string; to: string; reason?: string }
  | {
      kind: "delete";
      target: "entry" | "content_type" | "component";
      typeUid: string;
      entryId?: string;
      reason?: string;
    };
interface AssistantResponse {
  reply: string;
  trace: TraceItem[];
  proposals: Proposal[];
}
interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Pathname the turn was sent from — renders as a centered context chip on change */
  page?: string;
  trace?: TraceItem[];
  proposals?: Proposal[];
}

/** Human label for a route — the raw pathname is noise in the conversation */
function pageLabel(path: string): string {
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "content")
    return seg[2] ? `Content · ${seg[1]} · ${seg[2].slice(0, 8)}` : `Content · ${seg[1] ?? "home"}`;
  if (seg[0] === "ctb")
    return seg[1] === "component" ? `CTB · component · ${seg[2] ?? ""}` : `CTB · ${seg[1] ?? "home"}`;
  if (seg[0] === "settings") return `Settings · ${seg[1] ?? "home"}`;
  if (seg[0] === "media") return "Media Library";
  if (seg[0] === "taxonomy") return "Taxonomy";
  if (seg[0] === "templates") return `Templates · ${seg[1] ?? ""}`;
  if (seg[0] === "mcp") return "MCP Console";
  return path;
}

function PageChip({ path }: { path: string }) {
  return (
    <div className="assistant-page-chip">
      <span>{pageLabel(path)}</span>
    </div>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Conversation persistence (P3) — per workspace, survives reloads; capped */
const storageKey = () => `prina.assistant.${getWorkspaceSlug()}`;
const MAX_STORED_TURNS = 40;
function loadTurns(): ChatTurn[] {
  try {
    const raw = localStorage.getItem(storageKey());
    const parsed = raw ? (JSON.parse(raw) as ChatTurn[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Live tool activity while a streamed run is in flight */
interface LiveTool {
  tool: string;
  status: "running" | "ok" | "fail";
}

/** Minimal SSE reader over fetch — the api() helper is JSON-only */
async function streamAssistant(
  body: unknown,
  onProgress: (e: { type: string; tool: string; ok?: boolean; error?: string }) => void,
): Promise<AssistantResponse> {
  const res = await fetch("/api/ai/assistant/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-prina-workspace": getWorkspaceSlug(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
    const data = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "Request failed", null);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: AssistantResponse | null = null;
  let errorMsg: { message: string; code?: string } | null = null;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      if (event === "progress")
        onProgress(JSON.parse(data) as { type: string; tool: string; ok?: boolean; error?: string });
      else if (event === "done") done = JSON.parse(data) as AssistantResponse;
      else if (event === "error") errorMsg = JSON.parse(data) as { message: string; code?: string };
    }
  }
  if (errorMsg) throw new ApiError(500, errorMsg.code ?? "ERROR", errorMsg.message, null);
  if (!done) throw new ApiError(500, "ERROR", "Stream ended without a result", null);
  return done;
}

/** Route → screen context the server renders into the system prompt */
function routeContext(pathname: string) {
  const seg = pathname.split("/").filter(Boolean);
  const ctx: { page: string; typeUid?: string; entryId?: string } = { page: pathname };
  if (seg[0] === "content" && seg[1]) {
    ctx.typeUid = seg[1];
    if (seg[2] && UUID_RE.test(seg[2])) ctx.entryId = seg[2];
  } else if (seg[0] === "ctb" && seg[1]) {
    ctx.typeUid = seg[1];
  }
  return ctx;
}

/** REST call and label per proposal kind — the human's click IS the execution */
function proposalAction(p: Proposal): { label: string; exec(): Promise<unknown> } {
  if (p.kind === "transition") {
    const attempt = (to: string) =>
      api(`/api/content/${p.typeUid}/${p.entryId}/transition`, { method: "POST", body: { to } });
    return {
      label: p.to === "published" ? "Publish" : `Transition to ${p.to}`,
      // The single Confirm carries the human's intent; on a 4-stage workflow the direct jump
      // is not defined, so walk the chain (role guards on each step still apply and can stop it)
      exec: async () => {
        try {
          await attempt(p.to);
          return;
        } catch (e) {
          const chainable =
            p.to === "published" &&
            e instanceof ApiError &&
            /transition not allowed/i.test(e.message);
          if (!chainable) throw e;
          let reached = false;
          let lastError: unknown = e;
          for (const step of ["review", "approved", "published"]) {
            try {
              await attempt(step);
              if (step === "published") reached = true;
            } catch (err) {
              lastError = err; // "Already in 'review'" etc. — only the final outcome matters
            }
          }
          if (!reached) throw lastError;
        }
      },
    };
  }
  if (p.target === "entry") {
    return {
      label: "Delete entry",
      exec: () => api(`/api/content/${p.typeUid}/${p.entryId}`, { method: "DELETE" }),
    };
  }
  if (p.target === "component") {
    return {
      label: "Delete component",
      exec: () => api(`/api/components/${p.typeUid}`, { method: "DELETE" }),
    };
  }
  return {
    label: "Delete content type",
    exec: () => api(`/api/content-types/${p.typeUid}`, { method: "DELETE" }),
  };
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone(): void }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  const navigate = useNavigate();
  const location = useLocation();
  const action = proposalAction(p);
  /** Deleting what the user is looking at must not leave them on a dead page */
  const leaveDeletedPage = () => {
    if (p.kind !== "delete") return;
    const path = location.pathname;
    if (p.target === "entry" && p.entryId && path.startsWith(`/content/${p.typeUid}/${p.entryId}`)) {
      navigate(`/content/${p.typeUid}`);
    } else if (p.target === "content_type" && (path.startsWith(`/ctb/${p.typeUid}`) || path.startsWith(`/content/${p.typeUid}`))) {
      navigate("/ctb");
    } else if (p.target === "component" && path.startsWith(`/ctb/component/${p.typeUid}`)) {
      navigate("/ctb");
    }
  };
  const run = async () => {
    setState("busy");
    try {
      await action.exec();
      setState("done");
      onDone();
      leaveDeletedPage();
    } catch (e) {
      setState(e instanceof ApiError ? e.message : "Failed");
    }
  };
  return (
    <div className={p.kind === "delete" ? "assistant-card danger" : "assistant-card"}>
      <div>
        <strong>{action.label}</strong> <code>{p.typeUid}</code>
        {p.reason && <div className="muted">{p.reason}</div>}
      </div>
      {state === "done" ? (
        <span className="pill pill-published"><IconCheck size="1.2rem" /> Done</span>
      ) : (
        <button
          className={p.kind === "delete" ? "btn btn-sm btn-danger" : "btn btn-primary btn-sm"}
          disabled={state === "busy"}
          onClick={() => void run()}
        >
          {state === "busy" ? "…" : p.kind === "delete" ? "Delete" : "Confirm"}
        </button>
      )}
      {state !== "idle" && state !== "busy" && state !== "done" && (
        <span className="form-error">{state}</span>
      )}
    </div>
  );
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [turns, setTurns] = useState<ChatTurn[]>(loadTurns);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveTool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(turns.slice(-MAX_STORED_TURNS)));
    } catch {
      /* storage full/blocked — the conversation just stops persisting */
    }
  }, [turns]);

  const invalidate = () => {
    for (const key of ["content-types", "components", "entries", "entry", "document", "locales", "assets"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setError(null);
    const history = [...turns, { role: "user" as const, content, page: location.pathname }];
    setTurns(history);
    setInput("");
    setBusy(true);
    setLive([]);
    try {
      const res = await streamAssistant(
        {
          messages: history.map((t) => ({ role: t.role, content: t.content })),
          context: routeContext(location.pathname),
        },
        (e) => {
          if (e.type === "tool_start")
            setLive((prev) => [...prev, { tool: e.tool, status: "running" }]);
          else if (e.type === "tool_end")
            setLive((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i]!.tool === e.tool && next[i]!.status === "running") {
                  next[i] = { tool: e.tool, status: e.ok ? "ok" : "fail" };
                  break;
                }
              }
              return next;
            });
        },
      );
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: res.reply, trace: res.trace, proposals: res.proposals },
      ]);
      if (res.trace.some((x) => x.ok)) invalidate();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "AI_NOT_CONFIGURED"
          ? "AI is not configured — add an API key (BYOK) in Settings › AI."
          : e instanceof ApiError
            ? e.message
            : "Request failed",
      );
      setTurns((prev) => prev.slice(0, -1));
      setInput(content);
    } finally {
      setBusy(false);
      setLive([]);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 1e9 }));
    }
  };

  const clearChat = () => {
    setTurns([]);
    setError(null);
    try {
      localStorage.removeItem(storageKey());
    } catch {
      /* ignore */
    }
  };

  const renderTurn = (t: ChatTurn, i: number) => (
    <div key={i} className={t.role === "user" ? "assistant-bubble user" : "assistant-bubble"}>
      <div className="assistant-text">{t.content}</div>
      {t.trace && t.trace.length > 0 && (
        <div className="assistant-chips">
          {t.trace.map((x, j) => (
            <span key={j} className={x.ok ? "assistant-chip" : "assistant-chip fail"} title={x.error}>
              {x.tool}
            </span>
          ))}
        </div>
      )}
      {t.trace?.some((x) => !x.ok) && (
        <div className="assistant-fail-note">
          Some actions failed (red chips) — treat the reply above with care.
        </div>
      )}
      {t.proposals?.map((pp, j) => (
        <ProposalCard key={j} p={pp} onDone={invalidate} />
      ))}
    </div>
  );

  if (!open) return null;
  return (
    <aside className="assistant-panel">
      <div className="assistant-head">
        <IconRobot size="1.8rem" />
        <strong>Assistant</strong>
        <span className="muted">drafts only — you publish</span>
        <button className="btn btn-ghost btn-sm" title="New chat" disabled={busy || turns.length === 0}
          onClick={clearChat} style={{ marginLeft: "auto" }}>
          <IconEraser size="1.5rem" />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconX size="1.5rem" />
        </button>
      </div>
      <div className="assistant-msgs" ref={scrollRef}>
        {turns.length === 0 && (
          <p className="widget-hint">
            Ask in plain language — e.g. "add a price field to this type", "create an FAQ
            type with question/answer", "translate this entry to ja", "publish this entry"
            (you confirm the card).
          </p>
        )}
        {(() => {
          let lastPage: string | undefined;
          const out: JSX.Element[] = [];
          turns.forEach((t, i) => {
            if (t.page && t.page !== lastPage) {
              out.push(<PageChip key={`p${i}`} path={t.page} />);
              lastPage = t.page;
            }
            out.push(renderTurn(t, i));
          });
          // Live marker: always anchor the current screen when it differs from the last
          // recorded one (older conversations have no page records at all — show it anyway)
          if (turns.length > 0 && location.pathname !== lastPage) {
            out.push(<PageChip key="now" path={location.pathname} />);
          }
          return out;
        })()}
        {busy && (
          <div className="assistant-bubble">
            <span className="muted">Working…</span>
            {live.length > 0 && (
              <div className="assistant-chips">
                {live.map((x, i) => (
                  <span key={i}
                    className={x.status === "fail" ? "assistant-chip fail" : x.status === "running" ? "assistant-chip running" : "assistant-chip"}>
                    {x.tool}
                    {x.status === "running" ? "…" : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="assistant-input">
        <textarea
          rows={2}
          value={input}
          placeholder="Ask the assistant…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          <IconSend size="1.5rem" />
        </button>
      </div>
    </aside>
  );
}
