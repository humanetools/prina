/**
 * Saving a schema from the Content-type Builder (56-IMPL). The server refuses a change that leaves existing
 * entries needing a fix until it is confirmed; this asks the person — naming how many entries, which fields
 * and, above all, how many published entries go off the site — and sends the change again with `confirm`.
 */
import { api, ApiError } from "../../api/client";
import { confirmDialog } from "../../components/common/ConfirmDialog";

interface Impact {
  affected: number;
  published: number;
  byField: Record<string, number>;
  types: Array<{ uid: string; name: string; affected: number; published: number }>;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function describeImpact(impact: Impact): string {
  const lines = [
    `This change does not fit the values of ${n(impact.affected, "existing entry", "existing entries")}.`,
    "",
    impact.published > 0
      ? `⚠ ${n(impact.published, "published entry", "published entries")} will be UNPUBLISHED — taken off the site until each one is fixed and published again.`
      : "None of them is published, so nothing leaves the site.",
    "",
    "Nothing is converted or deleted: each entry keeps its values and shows what to fix.",
    "",
    `Fields: ${Object.entries(impact.byField).map(([field, count]) => `${field} (${count})`).join(", ")}`,
  ];
  if (impact.types.length > 1) lines.push(`Types: ${impact.types.map((t) => `${t.name} (${t.affected})`).join(", ")}`);
  return lines.join("\n");
}

/** PUT a type or component; asks for confirmation when the server says entries would need fixing */
export async function putSchema<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await api<T>(path, { method: "PUT", body });
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "SCHEMA_CHANGE_NEEDS_CONFIRMATION") throw e;
    const impact = e.details as Impact;
    const ok = await confirmDialog(describeImpact(impact), {
      confirmLabel: impact.published > 0 ? `Save and unpublish ${impact.published}` : "Save anyway",
      danger: true,
    });
    if (!ok) throw new ApiError(409, "SCHEMA_CHANGE_CANCELLED", "Not saved — the schema is unchanged.");
    return api<T>(path, { method: "PUT", body: { ...body, confirm: true } });
  }
}
