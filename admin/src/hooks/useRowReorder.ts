/**
 * Drag-to-reorder for a vertical list of rows, by a grip handle (pointer events — mouse, touch, pen).
 *
 * The handle captures the pointer, so the drag never turns into a text selection and the row's own
 * click does not fire. Rows are found by `data-reorder-key`; the drop slot is the gap nearest to the
 * pointer. The new order shows immediately and is kept until the caller's `items` change (the save
 * round trip), so the list does not snap back in between.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

export interface RowReorder<T> {
  /** `items` in the order to render */
  items: T[];
  /** Spread on the row's outermost element */
  rowProps(key: string): { "data-reorder-key": string; className: string };
  /** Spread on the grip */
  handleProps(key: string): {
    onPointerDown(e: React.PointerEvent<HTMLElement>): void;
    onPointerMove(e: React.PointerEvent<HTMLElement>): void;
    onPointerUp(e: React.PointerEvent<HTMLElement>): void;
    onPointerCancel(e: React.PointerEvent<HTMLElement>): void;
    onClick(e: React.MouseEvent): void;
  };
  dragging: boolean;
}

interface DragState { key: string; slot: number }

export function useRowReorder<T>(opts: {
  items: T[];
  keyOf(item: T): string;
  /** Called once on drop with the full new order */
  onReorder(next: T[]): void;
  disabled?: boolean;
}): RowReorder<T> {
  const { items, keyOf, onReorder, disabled } = opts;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const container = useRef<HTMLElement | null>(null);

  // the saved order arrived (or the list changed for another reason) — stop overriding it
  useEffect(() => setPending(null), [items]);

  const ordered = useMemo(() => {
    if (!pending) return items;
    const byKey = new Map(items.map((item) => [keyOf(item), item]));
    const next = pending.map((k) => byKey.get(k)).filter((x): x is T => x !== undefined);
    return next.length === items.length ? next : items;
  }, [items, pending, keyOf]);

  /** Gap index (0…n) nearest to the pointer */
  const slotAt = (clientY: number): number => {
    const rows = [...(container.current?.querySelectorAll<HTMLElement>(":scope > [data-reorder-key]") ?? [])];
    const at = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });
    return at === -1 ? rows.length : at;
  };

  const finish = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("row-reordering");
    const d = drag;
    setDrag(null);
    if (!d || !commit) return;
    const from = ordered.findIndex((item) => keyOf(item) === d.key);
    const to = d.slot > from ? d.slot - 1 : d.slot;
    if (from === -1 || to === from) return;
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setPending(next.map(keyOf));
    onReorder(next);
  };

  return {
    items: ordered,
    dragging: drag !== null,
    rowProps(key) {
      const index = ordered.findIndex((item) => keyOf(item) === key);
      const cls = ["reorder-row"];
      if (drag?.key === key) cls.push("is-dragging");
      // the two gaps around the dragged row would not move it — no indicator there
      const from = drag ? ordered.findIndex((item) => keyOf(item) === drag.key) : -1;
      const moves = drag !== null && drag.slot !== from && drag.slot !== from + 1;
      if (moves && drag!.slot === index) cls.push("drop-before");
      if (moves && drag!.slot === ordered.length && index === ordered.length - 1) cls.push("drop-after");
      return { "data-reorder-key": key, className: cls.join(" ") };
    },
    handleProps(key) {
      return {
        onPointerDown(e) {
          if (disabled || e.button !== 0) return;
          e.preventDefault(); // no text selection, no native drag
          e.stopPropagation();
          container.current = e.currentTarget.closest<HTMLElement>("[data-reorder-key]")?.parentElement ?? null;
          e.currentTarget.setPointerCapture(e.pointerId);
          document.body.classList.add("row-reordering");
          setDrag({ key, slot: slotAt(e.clientY) });
        },
        onPointerMove(e) {
          if (!drag) return;
          const slot = slotAt(e.clientY);
          if (slot !== drag.slot) setDrag({ key: drag.key, slot });
        },
        onPointerUp: (e) => finish(e, true),
        onPointerCancel: (e) => finish(e, false),
        onClick: (e) => e.stopPropagation(), // the grip never opens the row
      };
    },
  };
}
