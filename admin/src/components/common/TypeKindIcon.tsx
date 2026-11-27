/** Kind marker in front of a content type row (38-IMPL): a stack for collection types, a page for single types */
import { IconFileText, IconStack2 } from "@tabler/icons-react";
import { ContentTypeKind } from "../../api/types";

export function TypeKindIcon({ kind }: { kind: ContentTypeKind }) {
  const Icon = kind === ContentTypeKind.Single ? IconFileText : IconStack2;
  return <Icon className="nav-type-icon" size="1.6rem" aria-hidden />;
}
