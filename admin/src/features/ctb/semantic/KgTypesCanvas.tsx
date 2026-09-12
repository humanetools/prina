/**
 * Relation graph canvas — node = type, edge = relation field. Two modes share one coordinate space:
 * - Default: show only the current type + its relation target types
 * - Show all types: remaining types/edges appear in place (existing nodes do not move)
 * Layout/pan/label positions use a global ("all") localStorage scope — kept across mode/type switches.
 */
import { FieldType, type ContentType, type FieldDef } from "../../../api/types";
import { useKgViewport, type Layout } from "./useKgViewport";

export interface KgSelection {
  kind: "self" | "edge";
  fieldName?: string;
}

interface TypeEdge {
  key: string;
  fromUid: string;
  toUid: string;
  field: FieldDef;
}

/** Default layout — current type centered, the rest on an elliptical ring (overflow beyond 10 on an outer ring) */
function defaultLayout(currentUid: string, uids: string[]): Layout {
  const layout: Layout = { [currentUid]: { x: 0, y: 0 } };
  const others = uids.filter((u) => u !== currentUid);
  others.forEach((uid, i) => {
    const ring = Math.floor(i / 10);
    const inRing = Math.min(others.length - ring * 10, 10);
    const angle = ((i % 10) / inRing) * 2 * Math.PI - Math.PI / 2;
    const r = 320 + ring * 220;
    layout[uid] = { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.72 };
  });
  return layout;
}

export function KgTypesCanvas({
  types,
  currentUid,
  showAll,
  onToggleShowAll,
  selection,
  onSelect,
  onOpenType,
  resetToken,
}: {
  types: ContentType[];
  currentUid: string;
  showAll: boolean;
  onToggleShowAll(): void;
  selection: KgSelection;
  onSelect(sel: KgSelection): void;
  onOpenType(uid: string): void;
  resetToken: number;
}) {
  const uids = types.map((t) => t.uid);
  const byUid = new Map(types.map((t) => [t.uid, t]));
  const allEdges: TypeEdge[] = types.flatMap((t) =>
    t.definition.fields
      .filter((f) => f.type === FieldType.Relation && byUid.has(f.target as string))
      .map((f) => ({
        key: `${t.uid}.${f.name}`,
        fromUid: t.uid,
        toUid: f.target as string,
        field: f,
      })),
  );

  // Filter to visible only — layout is computed over all types, so toggling never moves positions
  const currentTargets = new Set(
    allEdges.filter((e) => e.fromUid === currentUid).map((e) => e.toUid),
  );
  const visibleUids = new Set(showAll ? uids : [currentUid, ...currentTargets]);
  const visibleTypes = types.filter((t) => visibleUids.has(t.uid));
  const edges = allEdges.filter((e) =>
    showAll ? true : e.fromUid === currentUid,
  ).filter((e) => visibleUids.has(e.fromUid) && visibleUids.has(e.toUid));

  const { layout, labelT, pan, viewportRef, panDown, nodeDown, labelDown, clickGuard } =
    useKgViewport({
      storageId: "all",
      buildDefaultLayout: () => defaultLayout(currentUid, uids),
      nodeSignature: uids.join(","),
      resetToken,
    });

  const pos = (uid: string) => layout[uid] ?? { x: 0, y: 0 };
  const isOn = (e: TypeEdge) =>
    e.fromUid === currentUid && selection.kind === "edge" && selection.fieldName === e.field.name;
  const pickEdge = (e: TypeEdge) =>
    e.fromUid === currentUid
      ? onSelect({ kind: "edge", fieldName: e.field.name })
      : onOpenType(e.fromUid);
  const pickNode = (uid: string) => {
    if (uid === currentUid) return onSelect({ kind: "self" });
    const edge = allEdges.find((e) => e.fromUid === currentUid && e.toUid === uid);
    if (edge) return onSelect({ kind: "edge", fieldName: edge.field.name });
    onOpenType(uid);
  };

  /** Parallel edges between the same node pair get staggered default label positions */
  const defaultT = (e: TypeEdge) => {
    const siblings = edges.filter((x) => x.fromUid === e.fromUid && x.toUid === e.toUid);
    if (siblings.length === 1) return 0.5;
    const nth = siblings.findIndex((x) => x.key === e.key);
    return 0.5 + (nth - (siblings.length - 1) / 2) * 0.16;
  };

  return (
    <div ref={viewportRef} className="kg-viewport" onPointerDown={panDown}>
      <div className="kg-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <svg className="kg-svg">
          {edges.filter((e) => e.fromUid !== e.toUid).map((e, i) => {
            const a = pos(e.fromUid);
            const b = pos(e.toUid);
            return (
              <line
                key={e.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={isOn(e) ? "kg-line kg-line-in on" : "kg-line kg-line-in"}
                style={{ "--kg-i": i } as React.CSSProperties}
              />
            );
          })}
        </svg>

        {visibleTypes.map((t, i) => {
          const p = pos(t.uid);
          const anim = { "--kg-i": i } as React.CSSProperties;
          if (t.uid === currentUid) {
            return (
              <button
                key={t.uid} data-kg-node="1"
                className={selection.kind === "self" ? "kg-self on" : "kg-self"}
                style={{ left: p.x, top: p.y }}
                onPointerDown={nodeDown(t.uid)}
                onClick={clickGuard(() => onSelect({ kind: "self" }))}
              >
                <span className="kg-self-kicker">This type</span>
                <span className="kg-self-name">{t.name}</span>
                <span className="kg-self-schema">
                  {t.schemaOrgType ? `schema:${t.schemaOrgType}` : "no schema type"}
                </span>
              </button>
            );
          }
          return (
            <button
              key={t.uid} data-kg-node="1"
              className="kg-node kg-in"
              style={{ left: p.x, top: p.y, ...anim }}
              onPointerDown={nodeDown(t.uid)}
              onClick={clickGuard(() => pickNode(t.uid))}
              title={currentTargets.has(t.uid) ? undefined : `Open ${t.name} · Predicate tab`}
            >
              <span className="kg-node-name">{t.name}</span>
              <span className="kg-node-note">
                {t.schemaOrgType ? `schema:${t.schemaOrgType}` : t.uid}
              </span>
            </button>
          );
        })}

        {edges.map((e, i) => {
          const a = pos(e.fromUid);
          const b = pos(e.toUid);
          const foreign = e.fromUid !== currentUid;
          const cls = isOn(e) ? "kg-edge-label on" : foreign ? "kg-edge-label dim" : "kg-edge-label";
          const anim = { "--kg-i": i } as React.CSSProperties;
          // Self-reference: segment length is 0, so stack below the node (no drag, click only)
          if (e.fromUid === e.toUid) {
            const nth = edges.slice(0, i).filter((x) => x.fromUid === e.fromUid && x.toUid === e.toUid).length;
            const baseGap = e.fromUid === currentUid ? 74 : 44;
            return (
              <button
                key={`label-${e.key}`} data-kg-node="1"
                className={`${cls} kg-in`}
                style={{ left: a.x, top: a.y + baseGap + nth * 26, ...anim }}
                onClick={clickGuard(() => pickEdge(e))}
                title="Self-relation"
              >
                ⟲ {(e.field.predicate as string) || e.field.name}
              </button>
            );
          }
          const t = labelT[e.key] ?? defaultT(e);
          return (
            <button
              key={`label-${e.key}`} data-kg-node="1"
              className={`${cls} kg-in`}
              style={{ left: a.x + (b.x - a.x) * t, top: a.y + (b.y - a.y) * t, ...anim }}
              onPointerDown={labelDown(e.key, e.fromUid, e.toUid)}
              onClick={clickGuard(() => pickEdge(e))}
            >
              {(e.field.predicate as string) || e.field.name}
            </button>
          );
        })}
      </div>

      {/* Canvas top-left overlay — excluded from pan start via data-kg-node */}
      <button
        data-kg-node="1"
        className="kg-toggle"
        onClick={onToggleShowAll}
        aria-pressed={showAll}
      >
        <span className={showAll ? "mini-switch" : "mini-switch off"} aria-hidden />
        <span>Show all types</span>
      </button>
    </div>
  );
}
