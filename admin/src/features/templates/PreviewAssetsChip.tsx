/** "Site assets: N" next to a preview — which workspace preview assets (43-IMPL) are inlined; links to the setting */
import { Link } from "react-router-dom";
import type { PreviewAsset } from "../../api/types";

export function PreviewAssetsChip({ assets }: { assets: PreviewAsset[] | undefined }) {
  const list = assets ?? [];
  const missing = list.filter((a) => a.missing);
  const ok = list.length - missing.length;
  const title =
    list.length === 0
      ? "No preview assets — Settings › System › Preview assets lists the site CSS the previews inline"
      : [
          ...list.filter((a) => !a.missing).map((a) => `${a.type}.${a.field} (${a.as})`),
          ...missing.map((a) => `${a.type}.${a.field} — missing`),
        ].join("\n");
  return (
    <Link
      to="/settings/system"
      className={`chip chip-sm preview-assets-chip${missing.length ? " warn" : ""}`}
      title={title}
      style={{ marginRight: "0.8rem", textDecoration: "none" }}
    >
      Site assets: {ok}
      {missing.length > 0 ? ` · ${missing.length} missing` : ""}
    </Link>
  );
}
