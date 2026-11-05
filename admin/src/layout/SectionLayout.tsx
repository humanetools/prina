/** Tier-2 context panel (264px, surface-2) + tier-3 main + tier-4 right panel (336px, Edit only) */
import { useEffect, useRef, useState, type ReactNode } from "react";

const MIN_W = 200;
const MAX_W = 640;
const clampW = (w: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));

/** Remembered context-panel width per screen (px), null = the token default */
function readWidth(key?: string): number | null {
  if (!key) return null;
  try {
    const v = Number(localStorage.getItem(`prina.panel.${key}`));
    return Number.isFinite(v) && v > 0 ? clampW(v) : null;
  } catch {
    return null;
  }
}

export function SectionLayout({
  panelTitle,
  panel,
  panelAction,
  rightPanel,
  resizeKey,
  children,
}: {
  panelTitle: string;
  panel: ReactNode;
  /** CTA under the panel title (e.g. Create new type — ai-soft button) */
  panelAction?: ReactNode;
  /** Edit-view-only tier-4 panel — attached as a sibling of main (independent scroll) */
  rightPanel?: ReactNode;
  /**
   * Makes the left/main separator draggable (2026-11-04, CTB · CM). The width is remembered per key in
   * localStorage — screens that share a key (all CM pages) share the width. Double-click resets it.
   */
  resizeKey?: string;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number | null>(() => readWidth(resizeKey));
  const asideRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startX: number; startW: number; last: number | null } | null>(null);
  /** time of the last press that did not move — two of them within 400ms = double-click (preventDefault on
   *  pointerdown can swallow the native dblclick, so it is detected here) */
  const lastTap = useRef(0);

  useEffect(() => setWidth(readWidth(resizeKey)), [resizeKey]);

  useEffect(() => {
    if (!resizeKey) return;
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const next = clampW(drag.current.startW + e.clientX - drag.current.startX);
      drag.current.last = next;
      setWidth(next);
    };
    const up = () => {
      if (!drag.current) return;
      const moved = drag.current.last;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // a plain click (no move) saves nothing — otherwise it would undo a double-click reset
      if (moved !== null) {
        lastTap.current = 0;
        try { localStorage.setItem(`prina.panel.${resizeKey}`, String(moved)); } catch { /* private mode */ }
        return;
      }
      const now = Date.now();
      if (now - lastTap.current < 400) {
        lastTap.current = 0;
        resetRef.current();
      } else lastTap.current = now;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [resizeKey]);

  const reset = () => {
    setWidth(null);
    try { if (resizeKey) localStorage.removeItem(`prina.panel.${resizeKey}`); } catch { /* private mode */ }
  };
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const nudge = (dx: number) => {
    const cur = width ?? asideRef.current?.getBoundingClientRect().width ?? 264;
    const next = clampW(cur + dx);
    setWidth(next);
    try { if (resizeKey) localStorage.setItem(`prina.panel.${resizeKey}`, String(next)); } catch { /* private mode */ }
  };

  return (
    <div className="section-layout">
      <aside className="context-panel" ref={asideRef} style={width !== null ? { width: `${width}px` } : undefined}>
        <div className="context-panel-title">{panelTitle}</div>
        {panelAction}
        <div className="context-panel-body">{panel}</div>
      </aside>
      {resizeKey && (
        <div
          className="context-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={(e) => {
            e.preventDefault();
            drag.current = { startX: e.clientX, startW: asideRef.current?.getBoundingClientRect().width ?? 264, last: null };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") nudge(-16);
            if (e.key === "ArrowRight") nudge(16);
          }}
        />
      )}
      <main className="page-main">{children}</main>
      {rightPanel}
    </div>
  );
}
