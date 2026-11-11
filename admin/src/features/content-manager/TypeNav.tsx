/** CM context panel: Collection/Single Types list (P3) — grouped in folders since 38-IMPL */
import { NavLink, useParams } from "react-router-dom";
import { type ContentType, ContentTypeKind } from "../../api/types";
import { useContentTypes } from "../../hooks/queries";
import { TypeKindIcon } from "../../components/common/TypeKindIcon";
import { TypeFolderGroup, typeDragProps } from "./TypeFolderGroup";

export function TypeNav() {
  const { data: types } = useContentTypes();
  const { typeUid } = useParams<{ typeUid: string }>();
  const collections = (types ?? []).filter((t) => t.kind === ContentTypeKind.Collection);
  const singles = (types ?? []).filter((t) => t.kind === ContentTypeKind.Single);

  const typeRow = (t: ContentType, indent: string | undefined) => (
    <NavLink
      key={t.uid}
      to={`/content/${t.uid}`}
      className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
      style={indent ? { paddingLeft: indent } : undefined}
      {...typeDragProps(t)}
    >
      <TypeKindIcon kind={t.kind} />
      <span className="nav-label">{t.name}</span>
      <span className="nav-count">{t.entryCount ?? ""}</span>
    </NavLink>
  );

  return (
    <>
      <TypeFolderGroup kind={ContentTypeKind.Collection} title="Collection Types" types={collections} renderType={typeRow} activeUid={typeUid} />
      <TypeFolderGroup kind={ContentTypeKind.Single} title="Single Types" types={singles} renderType={typeRow} activeUid={typeUid} />
    </>
  );
}
