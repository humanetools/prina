/**
 * Relation graph canvas — node = type or component, edge = relation field or "contains" (a component
 * field / dynamic zone that carries a component; the zone itself is not a node). Two modes share one
 * coordinate space:
 * - Default: show only the current type + its relation target types
 * - Show all types: remaining types/edges appear in place (existing nodes do not move)
 * Layout/pan/label positions use a global ("all") localStorage scope — kept across mode/type switches.
 */
import { collectTypeGraph, compNodeId, compUidOf, type GraphEdge, type GraphRelationEdge } from "./relation-paths";
import { type ContentType, type ComponentDef } from "../../../api/types";
import { useKgViewport, type Layout } from "./useKgViewport";
import { FieldTypeTile } from "../../../components/common/FieldTypeTile";

export interface KgSelection {
  kind: "self" | "edge" | "contains";
  /** edge: relation path · contains: the carrying field name */
  fieldName?: string;
  /** contains: component uid carried by that field */
  component?: string;
  through?: "zone" | "component";
}


/** Default layout — current type centered, components on an inner ring, types on an elliptical
 *  outer ring (overflow beyond 10 on a further ring) */
function defaultLayout(currentUid: string, uids: string[], compIds: string[]): Layout {
  const layout: Layout = { [currentUid]: { x: 0, y: 0 } };
  compIds.forEach((id, i) => {
    const angle = (i / Math.max(compIds.length, 1)) * 2 * Math.PI - Math.PI / 2 + Math.PI / 6;
    layout[id] = { x: Math.cos(angle) * 250, y: Math.sin(angle) * 250 * 0.62 };
  });
  const others = uids.filter((u) => u !== currentUid);
  others.forEach((uid, i) => {
    const ring = Math.floor(i / 10);
    const inRing = Math.min(others.length - ring * 10, 10);
    const angle = ((i % 10) / inRing) * 2 * Math.PI - Math.PI / 2;
    const r = 440 + ring * 240;
    layout[uid] = { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.62 };
  });
  return layout;
}

export function KgTypesCanvas({
  types,
  components,
  currentUid,
  showAll,
  onToggleShowAll,
  selection,
  onSelect,
  onOpenType,
  resetToken,
}: {
  types: ContentType[];
  /** Component definitions — relations inside components / dynamic zones become edges too */
  components?: ComponentDef[];
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
  const compByUid = new Map((components ?? []).map((c) => [c.uid, c]));
  const allEdges: GraphEdge[] = types.flatMap((t) =>
    collectTypeGraph(t.uid, t.definition, components).filter((e) =>
      e.kind === "contains" ? compByUid.has(compUidOf(e.to)) : byUid.has(e.to),
    ),
  );
  const relationEdges = allEdges.filter((e): e is GraphRelationEdge => e.kind === "relation");
  const compIdsAll = [...new Set(allEdges.filter((e) => e.kind === "contains").map((e) => e.to))];

  // Visible set — default: the current type, the components it contains, and every target those reach.
  // Layout is computed over all nodes, so toggling "show all" never moves positions.
  const ownEdges = allEdges.filter((e) => e.owner === currentUid);
  const visibleIds = new Set<string>(
    showAll
      ? [...uids, ...compIdsAll]
      : [currentUid, ...ownEdges.map((e) => e.to)],
  );
  const currentTargets = new Set(ownEdges.filter((e) => e.kind === "relation").map((e) => e.to));
  const visibleTypes = types.filter((t) => visibleIds.has(t.uid));
  const visibleComps = compIdsAll.filter((id) => visibleIds.has(id)).map((id) => compByUid.get(compUidOf(id))!);
  const edges = allEdges
    .filter((e) => (showAll ? true : e.owner === currentUid))
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  const { layout, labelT, pan, viewportRef, panDown, nodeDown, labelDown, clickGuard } =
    useKgViewport({
      storageId: "all",
      buildDefaultLayout: () => defaultLayout(currentUid, uids, compIdsAll),
      nodeSignature: [...uids, ...compIdsAll].join(","),
      resetToken,
    });

  const pos = (uid: string) => layout[uid] ?? { x: 0, y: 0 };
  const isOn = (e: GraphEdge) =>
    e.owner === currentUid &&
    (e.kind === "relation"
      ? selection.kind === "edge" && selection.fieldName === e.path
      : selection.kind === "contains" && selection.fieldName === e.field && selection.component === compUidOf(e.to));
  // Nodes never navigate (drag targets) — only a foreign edge chip opens its owner type
  const pickEdge = (e: GraphEdge) => {
    if (e.owner !== currentUid) return onOpenType(e.owner);
    if (e.kind === "contains") onSelect({ kind: "contains", fieldName: e.field, component: compUidOf(e.to), through: e.through });
    else onSelect({ kind: "edge", fieldName: e.path });
  };
  const pickNode = (uid: string) => {
    if (uid === currentUid) return onSelect({ kind: "self" });
    const edge = relationEdges.find((e) => e.owner === currentUid && e.to === uid);
    if (edge) onSelect({ kind: "edge", fieldName: edge.path });
  };

  /** Parallel edges between the same node pair get staggered default label positions */
  const keyOf = (e: GraphEdge) => (e.kind === "contains" ? `c:${e.owner}:${e.path}` : `${e.owner}.${e.path}`);
  const defaultT = (e: GraphEdge) => {
    const siblings = edges.filter((x) => x.from === e.from && x.to === e.to);
    if (siblings.length === 1) return 0.5;
    const nth = siblings.findIndex((x) => keyOf(x) === keyOf(e));
    return 0.5 + (nth - (siblings.length - 1) / 2) * 0.16;
  };

  return (
    <div ref={viewportRef} className="kg-viewport" onPointerDown={panDown}>
      <div className="kg-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <svg className="kg-svg">
          {edges.filter((e) => e.from !== e.to).map((e, i) => {
            const a = pos(e.from);
            const b = pos(e.to);
            return (
              <line
                key={keyOf(e)} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={`kg-line kg-line-in${e.kind === "contains" ? " zone" : ""}${isOn(e) ? " on" : ""}`}
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
              title={currentTargets.has(t.uid) ? undefined : t.name}
            >
              <span className="kg-node-name">{t.name}</span>
              <span className="kg-node-note">
                {t.schemaOrgType ? `schema:${t.schemaOrgType}` : t.uid}
              </span>
            </button>
          );
        })}

        {/* Component nodes — reached through a component field / dynamic zone; their relations point on */}
        {visibleComps.map((c, i) => {
          const id = compNodeId(c.uid);
          const p = pos(id);
          const anim = { "--kg-i": visibleTypes.length + i } as React.CSSProperties;
          return (
            <button
              key={id} data-kg-node="1"
              className="kg-node kg-comp kg-in"
              style={{ left: p.x, top: p.y, ...anim }}
              onPointerDown={nodeDown(id)}
              onClick={clickGuard(() => {})}
              title={`Component ${c.name} — reached through the dashed edge`}
            >
              <span className="kg-comp-kicker">component</span>
              <span className="kg-node-name">{c.name}</span>
              <span className="kg-node-note">{c.uid}</span>
            </button>
          );
        })}

        {edges.map((e, i) => {
          const a = pos(e.from);
          const b = pos(e.to);
          const key = keyOf(e);
          const foreign = e.owner !== currentUid;
          const cls = e.kind === "contains"
            ? `kg-edge-label icon${isOn(e) ? " on" : foreign ? " dim" : ""}`
            : isOn(e) ? "kg-edge-label on" : foreign ? "kg-edge-label dim" : "kg-edge-label";
          // contains: icon-only chip (∞ dynamic zone / ▤ component) — the field name lives in the tooltip
          const text = e.kind === "contains"
            ? <FieldTypeTile type={e.through === "zone" ? "dynamic_zone" : "component"} />
            : (e.def.predicate as string) || e.def.name;
          const anim = { "--kg-i": i } as React.CSSProperties;
          // Self-reference: segment length is 0, so stack below the node (no drag, click only)
          if (e.from === e.to) {
            const nth = edges.slice(0, i).filter((x) => x.from === e.from && x.to === e.to).length;
            const baseGap = e.from === currentUid ? 74 : 44;
            return (
              <button
                key={`label-${key}`} data-kg-node="1"
                className={`${cls} kg-in`}
                style={{ left: a.x, top: a.y + baseGap + nth * 26, ...anim }}
                onClick={clickGuard(() => pickEdge(e))}
                title="Self-relation"
              >
                ⟲ {text}
              </button>
            );
          }
          const t = labelT[key] ?? defaultT(e);
          return (
            <button
              key={`label-${key}`} data-kg-node="1"
              className={`${cls} kg-in`}
              style={{ left: a.x + (b.x - a.x) * t, top: a.y + (b.y - a.y) * t, ...anim }}
              onPointerDown={labelDown(key, e.from, e.to)}
              onClick={clickGuard(() => pickEdge(e))}
              title={e.kind === "contains" ? `${e.through === "zone" ? "Dynamic zone" : "Component field"} "${e.field}" carries this component` : undefined}
            >
              {text}
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
