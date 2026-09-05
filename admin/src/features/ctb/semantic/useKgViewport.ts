/**
 * Shared mechanics for relation graph canvases — pan, node drag, edge-label drag along the segment (t projection).
 * Shared by KgCanvas (current type, 1 hop) and KgTypesCanvas (Show all types).
 * Coordinates are world-based (origin at viewport center); layout/label positions persist in localStorage.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface Pt { x: number; y: number; }
export type Layout = Record<string, Pt>;

/** Clamp the position along the segment so the label never overlaps node boxes */
const LABEL_T_MIN = 0.1;
const LABEL_T_MAX = 0.9;

export function useKgViewport({
  storageId,
  buildDefaultLayout,
  nodeSignature,
  resetToken,
}: {
  /** localStorage key scope (e.g. type uid, "all:{uid}") */
  storageId: string;
  buildDefaultLayout(): Layout;
  /** Node set signature — when it changes, default layout is merged in for new nodes */
  nodeSignature: string;
  resetToken: number;
}) {
  const storageKey = `kg-layout:${storageId}`;
  const labelKey = `kg-labelt:${storageId}`;
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Layout | null;
      if (saved) return { ...buildDefaultLayout(), ...saved };
    } catch { /* ignore */ }
    return buildDefaultLayout();
  });
  /** Edge label position along the segment (0~1, default 0.5) — keyed by edge key */
  const [labelT, setLabelT] = useState<Record<string, number>>(() => {
    try {
      return (JSON.parse(localStorage.getItem(labelKey) ?? "null") as Record<string, number> | null) ?? {};
    } catch { return {}; }
  });
  const panKey = `kg-pan:${storageId}`;
  const [pan, setPan] = useState<Pt>(() => {
    try {
      return (JSON.parse(localStorage.getItem(panKey) ?? "null") as Pt | null) ?? { x: 0, y: 0 };
    } catch { return { x: 0, y: 0 }; }
  });
  const viewportRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const drag = useRef<{
    mode: "pan" | "node" | "label";
    key?: string;
    /** label mode: node keys of both endpoints of the segment to project onto */
    fromKey?: string;
    toKey?: string;
    start: Pt;
    origin: Pt;
    /** label mode: client coords of the world origin (viewport center + pan) */
    worldOrigin?: Pt;
    moved: boolean;
  } | null>(null);

  // Reset layout
  useEffect(() => {
    if (resetToken === 0) return;
    localStorage.removeItem(storageKey);
    localStorage.removeItem(labelKey);
    localStorage.removeItem(panKey);
    setLayout(buildDefaultLayout());
    setLabelT({});
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  // Apply node additions/removals
  useEffect(() => {
    setLayout((l) => ({ ...buildDefaultLayout(), ...l }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSignature]);

  const persist = useCallback((l: Layout) => {
    try { localStorage.setItem(storageKey, JSON.stringify(l)); } catch { /* ignore */ }
  }, [storageKey]);
  const persistT = useCallback((m: Record<string, number>) => {
    try { localStorage.setItem(labelKey, JSON.stringify(m)); } catch { /* ignore */ }
  }, [labelKey]);
  const persistPan = useCallback((p: Pt) => {
    try { localStorage.setItem(panKey, JSON.stringify(p)); } catch { /* ignore */ }
  }, [panKey]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.mode === "pan") {
        setPan({ x: d.origin.x + dx, y: d.origin.y + dy });
      } else if (d.mode === "node" && d.key) {
        setLayout((l) => ({ ...l, [d.key!]: { x: d.origin.x + dx, y: d.origin.y + dy } }));
      } else if (d.mode === "label" && d.key && d.fromKey && d.toKey && d.worldOrigin) {
        // Project the pointer's world coords onto the from→to segment to update t
        const a = layoutRef.current[d.fromKey] ?? { x: 0, y: 0 };
        const b = layoutRef.current[d.toKey] ?? { x: 0, y: 0 };
        const wx = e.clientX - d.worldOrigin.x;
        const wy = e.clientY - d.worldOrigin.y;
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1) return;
        const t = Math.min(LABEL_T_MAX, Math.max(LABEL_T_MIN, ((wx - a.x) * vx + (wy - a.y) * vy) / len2));
        setLabelT((m) => ({ ...m, [d.key!]: t }));
      }
    };
    const up = () => {
      if (drag.current?.mode === "node") setLayout((l) => { persist(l); return l; });
      if (drag.current?.mode === "label") setLabelT((m) => { persistT(m); return m; });
      if (drag.current?.mode === "pan") setPan((p) => { persistPan(p); return p; });
      drag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [persist, persistT, persistPan]);

  const panDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-kg-node]")) return;
    e.preventDefault();
    drag.current = { mode: "pan", start: { x: e.clientX, y: e.clientY }, origin: pan, moved: false };
  };
  const nodeDown = (key: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const p = layoutRef.current[key] ?? { x: 0, y: 0 };
    drag.current = { mode: "node", key, start: { x: e.clientX, y: e.clientY }, origin: p, moved: false };
  };
  const labelDown = (key: string, fromKey: string, toKey: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      mode: "label",
      key,
      fromKey,
      toKey,
      start: { x: e.clientX, y: e.clientY },
      origin: { x: 0, y: 0 },
      worldOrigin: { x: rect.left + rect.width / 2 + pan.x, y: rect.top + rect.height / 2 + pan.y },
      moved: false,
    };
  };
  /** Prevent the post-drag click event from changing the selection */
  const clickGuard = (fn: () => void) => () => {
    if (drag.current?.moved) return;
    fn();
  };

  return { layout, labelT, pan, viewportRef, panDown, nodeDown, labelDown, clickGuard };
}
