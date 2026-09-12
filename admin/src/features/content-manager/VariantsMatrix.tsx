/** Variants matrix (P4, §2.8): child SKU rows — inherited values gray, overrides highlighted */
import { useNavigate } from "react-router-dom";
import { FieldType, type ContentType, type EntryDetail } from "../../api/types";
import { StatusPill } from "../../components/common/StatusPill";
import { displayValue } from "./format";

export function VariantsMatrix({
  contentType,
  detail,
}: {
  contentType: ContentType;
  detail: EntryDetail;
}) {
  const navigate = useNavigate();
  if (detail.variants.length === 0) return null;

  // Representative fields shown in the matrix: top 3, number/text first (variant_axis excluded)
  const showFields = contentType.definition.fields
    .filter((f) =>
      [FieldType.Number, FieldType.Text, FieldType.Enum].includes(f.type),
    )
    .slice(0, 3);
  const axisNames = [
    ...new Set(detail.variants.flatMap((v) => Object.keys(v.variantValues ?? {}))),
  ];

  return (
    <section className="variants-matrix">
      <h3>Variants ({detail.variants.length})</h3>
      <table className="data-table">
        <thead>
          <tr>
            {axisNames.map((a) => (
              <th key={a}>{a}</th>
            ))}
            <th>Status</th>
            {showFields.map((f) => (
              <th key={f.name}>{f.label ?? f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {detail.variants.map((v) => (
            <tr
              key={v.id}
              className="row-link"
              onClick={() => navigate(`/content/${contentType.uid}/${v.id}`)}
            >
              {axisNames.map((a) => (
                <td key={a}><strong>{v.variantValues?.[a] ?? "—"}</strong></td>
              ))}
              <td><StatusPill status={v.status} /></td>
              {showFields.map((f) => {
                const overridden = f.name in v.values;
                const effective = overridden
                  ? v.values[f.name]
                  : detail.entry.values[f.name];
                return (
                  <td
                    key={f.name}
                    className={overridden ? "cell-override" : "cell-inherited"}
                    title={overridden ? "override" : "Inherited from parent"}
                  >
                    {displayValue(effective)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="widget-hint">
        Grey = inherited from parent, highlighted = override. Click a row to edit the child SKU.
      </div>
    </section>
  );
}
