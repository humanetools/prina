/** CM context panel: Collection/Single Types list (P3) */
import { NavLink } from "react-router-dom";
import { ContentTypeKind } from "../../api/types";
import { useContentTypes } from "../../hooks/queries";

export function TypeNav() {
  const { data: types } = useContentTypes();
  const collections = (types ?? []).filter((t) => t.kind === ContentTypeKind.Collection);
  const singles = (types ?? []).filter((t) => t.kind === ContentTypeKind.Single);

  const group = (title: string, items: typeof collections) => (
    <div className="nav-group">
      <div className="nav-group-title">{title}</div>
      {items.length === 0 && <div className="nav-empty">None</div>}
      {items.map((t) => (
        <NavLink
          key={t.uid}
          to={`/content/${t.uid}`}
          className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
        >
          <span className="nav-label">{t.name}</span>
          <span className="nav-count">{t.entryCount ?? ""}</span>
        </NavLink>
      ))}
    </div>
  );

  return (
    <>
      {group("Collection Types", collections)}
      {group("Single Types", singles)}
    </>
  );
}
