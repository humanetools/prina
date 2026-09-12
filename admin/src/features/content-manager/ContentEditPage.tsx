/** CM Edit view (P4, T3.4) — schema-driven form + right panel + variants + taxonomy + versions */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { IconChevronLeft, IconRobot } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import { FieldType, type EntryDetail } from "../../api/types";
import { useContentTypes, useEntry } from "../../hooks/queries";
import { SectionLayout } from "../../layout/SectionLayout";
import { Spinner } from "../../components/common/Spinner";
import { TypeNav } from "./TypeNav";
import { FieldRow } from "./widgets/FieldRow";
import { RightPanel } from "./RightPanel";
import { VariantsMatrix } from "./VariantsMatrix";
import { adminEe } from "../../ee-loader";
import { PreviewModal } from "./PreviewModal";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { TaxonomySection } from "./TaxonomySection";
import { SeoSection } from "./SeoSection";
import { entryLabel } from "./format";

export function ContentEditPage({ mode }: { mode: "create" | "edit" }) {
  const { typeUid, id } = useParams<{ typeUid: string; id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: types } = useContentTypes();
  const contentType = types?.find((t) => t.uid === typeUid);
  const { data: detail, isLoading } = useEntry(
    mode === "edit" ? typeUid : undefined,
    mode === "edit" ? id : undefined,
  );

  /** Patch being edited — only these fields are PUT on save (partial merge, same as the server contract) */
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<{ message: string; issues?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    // Create mode may start from EE-provided initial values (e.g. the chatbot gap report's
    // "create an entry for this") — optional slot, one-shot, empty form when absent
    const prefill =
      mode === "create" && typeUid ? adminEe?.consumeCreatePrefill?.(typeUid) : null;
    setPatch(prefill ?? {});
    setError(null);
  }, [typeUid, id, mode]);

  const isChild = mode === "edit" && !!detail?.entry.parentEntryId;
  const fields = useMemo(
    () =>
      (contentType?.definition.fields ?? []).filter(
        (f) => !(isChild && f.type === FieldType.VariantAxis),
      ),
    [contentType, isChild],
  );

  if (!contentType || (mode === "edit" && isLoading)) {
    return (
      <SectionLayout panelTitle="Content Manager" panel={<TypeNav />}>
        <div className="center-block"><Spinner /></div>
      </SectionLayout>
    );
  }

  const valueOf = (name: string): unknown => {
    if (name in patch) return patch[name];
    if (mode === "create") return null;
    return isChild ? detail!.effectiveValues[name] : detail!.entry.values[name];
  };
  const isInherited = (name: string): boolean =>
    isChild && !(name in patch) && !(name in (detail?.entry.values ?? {}));

  const handleError = (e: unknown) => {
    if (e instanceof ApiError) {
      const details = e.details as { issues?: string[]; missing?: Array<{ field: string; reason: string }> } | null;
      setError({
        message: e.message,
        issues:
          details?.issues ??
          details?.missing?.map((m) => `${m.field}: ${m.reason}`),
      });
    } else setError({ message: "Request failed" });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const created = await api<{ entry: { id: string } }>(`/api/content/${typeUid}`, {
          method: "POST",
          body: { values: patch },
        });
        await qc.invalidateQueries({ queryKey: ["entries", typeUid] });
        navigate(`/content/${typeUid}/${created.entry.id}`);
      } else {
        await api(`/api/content/${typeUid}/${id}`, { method: "PUT", body: { values: patch } });
        setPatch({});
        await qc.invalidateQueries({ queryKey: ["entry", typeUid, id] });
        await qc.invalidateQueries({ queryKey: ["entries", typeUid] });
        // Locale chips read sibling status + AI-draft marks (IMPL-ai-locale-translation)
        await qc.invalidateQueries({ queryKey: ["document", typeUid] });
        await qc.invalidateQueries({ queryKey: ["versions", typeUid, id] });
        // When media references change, refresh asset usage counts/details too (T4.3)
        await qc.invalidateQueries({ queryKey: ["asset"] });
        await qc.invalidateQueries({ queryKey: ["assets"] });
      }
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const transition = async (to: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/content/${typeUid}/${id}/transition`, { method: "POST", body: { to } });
      await qc.invalidateQueries({ queryKey: ["entry", typeUid, id] });
      await qc.invalidateQueries({ queryKey: ["entries", typeUid] });
      await qc.invalidateQueries({ queryKey: ["document", typeUid] });
      await qc.invalidateQueries({ queryKey: ["activity", id] });
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const dirty = Object.keys(patch).length > 0;
  const title =
    mode === "create"
      ? `New ${contentType.name}`
      : entryLabel(
          contentType.definition,
          detail!.effectiveValues as Record<string, unknown>,
          detail!.entry.id,
        );

  return (
    <SectionLayout
      panelTitle="Content Manager"
      panel={<TypeNav />}
      rightPanel={
        mode === "edit" && detail ? (
          <RightPanel
            entry={detail.entry}
            completeness={detail.completeness}
            advisories={detail.advisories ?? []}
            blockPublish={
              (contentType.options?.seo?.strictPublish ?? false) &&
              (detail.advisories ?? []).some((a) => a.severity === "error")
            }
            dirty={dirty}
            onSave={() => void save()}
            onTransition={(to) => void transition(to)}
            onShowVersions={() => setVersionsOpen(true)}
            onShowPreview={() => setPreviewOpen(true)}
            busy={busy}
          />
        ) : undefined
      }
    >
      <div className="edit-layout">
        <div className="edit-main">
          <div className="breadcrumb">
            <Link to={`/content/${typeUid}`}><IconChevronLeft size="1.5rem" /> {contentType.name}</Link>
            {isChild && detail?.entry.parentEntryId && (
              <>
                <span>/</span>
                <Link to={`/content/${typeUid}/${detail.entry.parentEntryId}`}>Parent</Link>
              </>
            )}
            <span>/</span>
            <strong>{title}</strong>
            {isChild && detail?.entry.variantValues && (
              <code className="variant-combo">
                {Object.entries(detail.entry.variantValues)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" · ")}
              </code>
            )}
          </div>

          {mode === "edit" && detail && !isChild && (
            <LocaleSwitcher typeUid={typeUid!} entry={detail.entry} />
          )}

          {mode === "edit" && detail?.entry.aiDraft && (
            <div className="ai-draft-banner">
              <IconRobot size="1.6rem" />
              {detail.entry.aiDraft.kind === "translation" && detail.entry.aiDraft.sourceEntryId ? (
                <span>
                  AI-translated <strong>draft</strong> from the{" "}
                  <Link to={`/content/${typeUid}/${detail.entry.aiDraft.sourceEntryId}`}>
                    <code>{detail.entry.aiDraft.sourceLocale}</code> entry
                  </Link>
                  {" "}— review and edit; saving or publishing marks it reviewed.
                </span>
              ) : (
                <span>
                  <strong>Draft</strong> written by the AI assistant — review and edit;
                  saving or publishing marks it reviewed.
                </span>
              )}
            </div>
          )}

          <div className="page-head">
            <h1>{title}</h1>
            {mode === "create" && (
              <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </button>
            )}
          </div>

          {error && (
            <div className="form-error">
              {error.message}
              {error.issues && (
                <ul>{error.issues.map((i) => <li key={i}>{i}</li>)}</ul>
              )}
            </div>
          )}

          <div className="form-fields">
            {fields.map((f) => (
              <FieldRow
                key={f.name}
                field={f}
                value={valueOf(f.name)}
                inherited={isInherited(f.name)}
                self={
                  detail
                    ? { id: detail.entry.id, documentId: detail.entry.documentId }
                    : undefined
                }
                onChange={(v) => setPatch((p) => ({ ...p, [f.name]: v }))}
                onClearOverride={
                  isChild && f.name in (detail?.entry.values ?? {})
                    ? () => setPatch((p) => ({ ...p, [f.name]: null }))
                    : undefined
                }
              />
            ))}
          </div>

          {mode === "edit" && detail && (
            <>
              <TaxonomySection typeUid={typeUid!} detail={detail} />
              {contentType.options?.seo?.enabled && !isChild && (
                <SeoSection typeUid={typeUid!} detail={detail} contentType={contentType} />
              )}
              <VariantsMatrix contentType={contentType} detail={detail as EntryDetail} />
            </>
          )}
        </div>

      </div>

      {versionsOpen && mode === "edit" && adminEe && (
        <adminEe.VersionHistoryModal
          typeUid={typeUid!}
          entryId={id!}
          onClose={() => setVersionsOpen(false)}
        />
      )}
      {previewOpen && mode === "edit" && (
        <PreviewModal typeUid={typeUid!} entryId={id!} onClose={() => setPreviewOpen(false)} />
      )}
    </SectionLayout>
  );
}
