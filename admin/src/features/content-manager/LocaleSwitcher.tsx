/**
 * Edit view locale switcher (P4, T2.4) — navigate/create the document's per-locale entries.
 * + AI translation (IMPL-ai-locale-translation): drafts missing locales from the open entry;
 * chips carry a robot mark while a locale is an unreviewed AI draft.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { IconRobot, IconSparkles } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type ComponentDef, type ContentTypeDefinition, type Entry, type FieldDef } from "../../api/types";
import {
  useComponents,
  useContentTypes,
  useDocumentEntries,
  useInvalidatingMutation,
  useLocales,
} from "../../hooks/queries";
import { StatusPill } from "../../components/common/StatusPill";
import { Modal } from "../../components/common/Modal";

/** Per-locale progress of one translation run */
type RunState = Record<string, "waiting" | "running" | "done" | string>;

/** One checkbox in the field list — key = index-free logical path the server understands */
interface FieldRowDef {
  key: string;
  label: string;
  indent?: boolean;
}

const fieldLabel = (f: FieldDef) => f.label || f.name;

/** Leaves inside a component: text, richtext, media alt (matches the server walker) */
function componentLeafRows(
  parentKey: string,
  parentLabel: string,
  def: ContentTypeDefinition | undefined,
): FieldRowDef[] {
  const rows: FieldRowDef[] = [];
  for (const f of def?.fields ?? []) {
    if (f.type === FieldType.Text || f.type === FieldType.Richtext) {
      rows.push({ key: `${parentKey}.${f.name}`, label: `${parentLabel} › ${fieldLabel(f)}`, indent: true });
    } else if (f.type === FieldType.Media && (f as { altText?: boolean }).altText) {
      rows.push({ key: `${parentKey}.${f.name}`, label: `${parentLabel} › ${fieldLabel(f)} (alt text)`, indent: true });
    }
  }
  return rows;
}

/**
 * Everything translation can touch, as checkboxes — top-level text/richtext/media alt plus
 * the fields inside components and each dynamic-zone component (translation reaches them).
 */
function buildFieldRows(
  definition: ContentTypeDefinition | undefined,
  components: ComponentDef[] | undefined,
): FieldRowDef[] {
  const byUid = new Map((components ?? []).map((c) => [c.uid, c.definition]));
  const rows: FieldRowDef[] = [];
  for (const f of definition?.fields ?? []) {
    if (f.type === FieldType.Text || f.type === FieldType.Richtext) {
      rows.push({ key: f.name, label: fieldLabel(f) });
    } else if (f.type === FieldType.Media && (f as { altText?: boolean }).altText) {
      rows.push({ key: f.name, label: `${fieldLabel(f)} (alt text)` });
    } else if (f.type === FieldType.Component) {
      rows.push(...componentLeafRows(f.name, fieldLabel(f), byUid.get((f as { component?: string }).component ?? "")));
    } else if (f.type === FieldType.DynamicZone) {
      for (const uid of (f as { components?: string[] }).components ?? []) {
        rows.push(...componentLeafRows(`${f.name}.${uid}`, `${fieldLabel(f)} › ${uid}`, byUid.get(uid)));
      }
    }
  }
  return rows;
}

function TranslateModal({
  typeUid,
  entry,
  missing,
  onClose,
}: {
  typeUid: string;
  entry: Entry;
  missing: Array<{ code: string; name: string }>;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set(missing.map((l) => l.code)));
  const [run, setRun] = useState<RunState | null>(null);
  const busy = !!run && Object.values(run).some((s) => s === "waiting" || s === "running");

  const { data: types } = useContentTypes();
  const { data: components } = useComponents();
  const contentType = types?.find((t) => t.uid === typeUid);
  const fieldRows = useMemo(
    () => buildFieldRows(contentType?.definition, components),
    [contentType, components],
  );
  /**
   * Default selection mirrors the schema's Localizable declarations: when any field is
   * marked, only marked fields start checked; a type with no marks starts all-checked.
   * The editor's per-run toggles always win over the declaration (the declaration
   * seeds the default, the later selection decides).
   */
  const defaultExcluded = useMemo(() => {
    const fields = contentType?.definition.fields ?? [];
    const anyLocalized = fields.some((f) => f.localized === true);
    if (!anyLocalized) return new Set<string>();
    const localizedRoots = new Set(fields.filter((f) => f.localized === true).map((f) => f.name));
    return new Set(fieldRows.map((r) => r.key).filter((k) => !localizedRoots.has(k.split(".")[0]!)));
  }, [contentType, fieldRows]);
  const [userExcluded, setUserExcluded] = useState<Set<string> | null>(null);
  const excluded = userExcluded ?? defaultExcluded;
  const [includeSeo, setIncludeSeo] = useState(true);
  const seoEnabled = contentType?.options?.seo?.enabled ?? false;

  const toggleField = (key: string) =>
    setUserExcluded(() => {
      const next = new Set(excluded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const start = async () => {
    const targets = missing.filter((l) => selected.has(l.code)).map((l) => l.code);
    const fields = fieldRows.filter((r) => !excluded.has(r.key)).map((r) => r.key);
    setRun(Object.fromEntries(targets.map((c) => [c, "waiting"])));
    // Sequential on purpose: one LLM roundtrip per locale server-side; failures stay per-locale
    for (const locale of targets) {
      setRun((r) => ({ ...r!, [locale]: "running" }));
      try {
        await api("/api/ai/translate", {
          method: "POST",
          body: {
            typeUid,
            sourceEntryId: entry.id,
            targetLocale: locale,
            fields,
            includeSeo: seoEnabled ? includeSeo : false,
          },
        });
        setRun((r) => ({ ...r!, [locale]: "done" }));
      } catch (e) {
        const message =
          e instanceof ApiError && e.code === "AI_NOT_CONFIGURED"
            ? "AI is not configured — add an API key (BYOK) in Settings › AI."
            : e instanceof ApiError
              ? e.message
              : "Translation failed";
        setRun((r) => ({ ...r!, [locale]: message }));
      }
      await qc.invalidateQueries({ queryKey: ["document", typeUid, entry.documentId] });
      await qc.invalidateQueries({ queryKey: ["entries", typeUid] });
    }
  };

  return (
    <Modal title="Translate with AI" onClose={onClose}>
      <div className="form-fields">
        <div className="ai-draft-banner">
          <IconRobot size="1.6rem" />
          AI writes <strong>drafts</strong> for the selected locales from this{" "}
          <code>{entry.locale}</code> entry. Review each one, then publish.
        </div>
        <div className="field"><span>Target locales</span></div>
        {missing.map((l) => (
          <label key={l.code} className="check-row">
            <input
              type="checkbox"
              disabled={!!run}
              checked={selected.has(l.code)}
              onChange={(e) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(l.code);
                  else next.delete(l.code);
                  return next;
                })
              }
            />
            <code>{l.code}</code> {l.name}
            {run && run[l.code] && (
              <span className={run[l.code] === "done" ? "pill pill-published" : run[l.code] === "waiting" || run[l.code] === "running" ? "muted" : "form-error"}
                style={{ marginLeft: "auto" }}>
                {run[l.code] === "waiting" ? "…" : run[l.code] === "running" ? "Translating…" : run[l.code] === "done" ? "Draft ready" : run[l.code]}
              </span>
            )}
          </label>
        ))}

        <div className="field"><span>Fields to translate</span></div>
        <div className="translate-fields">
          {fieldRows.map((r) => (
            <label key={r.key} className={r.indent ? "check-row indent" : "check-row"}>
              <input
                type="checkbox"
                disabled={!!run}
                checked={!excluded.has(r.key)}
                onChange={() => toggleField(r.key)}
              />
              {r.label}
            </label>
          ))}
          {seoEnabled && (
            <label className="check-row">
              <input type="checkbox" disabled={!!run} checked={includeSeo}
                onChange={() => setIncludeSeo((v) => !v)} />
              SEO metadata (meta title · description · OG texts)
            </label>
          )}
          {fieldRows.length === 0 && !seoEnabled && (
            <span className="muted">No translatable fields — values will be copied as-is.</span>
          )}
        </div>
        <p className="widget-hint">
          Unchecked fields are copied from the source unchanged. Numbers, dates, relations
          and slugs are always copied — they are not language-bound. Defaults follow the
          fields' Localizable setting (Content-Type Builder); your choice here wins for this run.
        </p>
        <div className="row-gap">
          <button className="btn" onClick={onClose}>{run && !busy ? "Close" : "Cancel"}</button>
          {!run && (
            <button className="btn btn-primary" disabled={selected.size === 0}
              onClick={() => void start()}>
              <IconSparkles size="1.5rem" /> Translate {selected.size} locale{selected.size === 1 ? "" : "s"}
            </button>
          )}
        </div>
        <p className="widget-hint">
          Existing locale versions are never overwritten. A draft's robot mark clears when a
          human saves or publishes it.
        </p>
      </div>
    </Modal>
  );
}

export function LocaleSwitcher({
  typeUid,
  entry,
}: {
  typeUid: string;
  entry: Entry;
}) {
  const navigate = useNavigate();
  const { data: locales } = useLocales();
  const { data: siblings } = useDocumentEntries(typeUid, entry.documentId);
  const [translateOpen, setTranslateOpen] = useState(false);

  const createLocale = useInvalidatingMutation(
    (locale: string) =>
      api<{ entry: Entry }>(`/api/content/${typeUid}`, {
        method: "POST",
        body: { values: {}, locale, documentId: entry.documentId },
      }),
    [["document", typeUid, entry.documentId], ["entries", typeUid]],
  );

  const existing = new Map((siblings ?? []).map((s) => [s.locale, s]));
  const missing = (locales ?? []).filter((l) => !existing.has(l.code));

  return (
    <div className="locale-switcher">
      {(locales ?? []).map((l) => {
        const sibling = existing.get(l.code);
        const current = entry.locale === l.code;
        if (sibling) {
          return (
            <button
              key={l.code}
              className={current ? "locale-tab active" : "locale-tab"}
              title={sibling.aiDraft ? "AI-translated draft — awaiting review" : undefined}
              onClick={() => !current && navigate(`/content/${typeUid}/${sibling.id}`)}
            >
              <code>{l.code}</code>
              {sibling.aiDraft && <IconRobot size="1.4rem" className="locale-ai-mark" />}
              <StatusPill status={sibling.status} />
            </button>
          );
        }
        return (
          <button
            key={l.code}
            className="locale-tab missing"
            title={`Create the ${l.name} version`}
            onClick={() =>
              createLocale.mutate(l.code, {
                onSuccess: (r) => navigate(`/content/${typeUid}/${r.entry.id}`),
              })
            }
          >
            <code>{l.code}</code>
            <span>+ Create</span>
          </button>
        );
      })}
      {missing.length > 0 && (
        <button
          className="locale-tab missing"
          title="Draft the missing locales with AI, then review each one"
          onClick={() => setTranslateOpen(true)}
        >
          <IconSparkles size="1.4rem" /> Translate with AI
        </button>
      )}
      {translateOpen && (
        <TranslateModal
          typeUid={typeUid}
          entry={entry}
          missing={missing.map((l) => ({ code: l.code, name: l.name }))}
          onClose={() => setTranslateOpen(false)}
        />
      )}
    </div>
  );
}
