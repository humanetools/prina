/** Preset gallery (T7.2, §2.9) — design Preset gallery section + Preset detail modal. Install = copy */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { IconChevronRight, IconSearch, IconX } from "@tabler/icons-react";
import { api, ApiError } from "../../api/client";
import type { FieldDef } from "../../api/types";
import { useContentTypes, useInvalidatingMutation } from "../../hooks/queries";
import { FieldTypeTile } from "../../components/common/FieldTypeTile";
import { TYPE_LABEL, fieldRuleSummary } from "./field-modal/meta";

interface PresetInfo {
  id: string;
  name: string;
  description: string;
  uid: string;
  schemaOrgType: string | null;
  fieldCount: number;
  fields: FieldDef[];
  components: string[];
}

export function PresetGallery() {
  const navigate = useNavigate();
  const { data: types } = useContentTypes();
  const { data: presets } = useQuery({
    queryKey: ["presets"],
    queryFn: () => api<PresetInfo[]>("/api/presets"),
  });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<PresetInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installedUids = new Set((types ?? []).map((t) => t.uid));
  const list = (presets ?? []).filter(
    (p) => !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const install = useInvalidatingMutation(
    (presetId: string) =>
      api<{ uid: string }>(`/api/presets/${presetId}/install`, { method: "POST", body: {} }),
    [["content-types"], ["components"]],
  );

  const runInstall = (p: PresetInfo) => {
    setError(null);
    install.mutate(p.id, {
      onSuccess: (r) => {
        setDetail(null);
        navigate(`/ctb/${r.uid}`);
      },
      onError: (e) => setError(e instanceof ApiError ? e.message : "Install failed"),
    });
  };

  return (
    <section className="pg">
      <div className="pg-head">
        <button className="pg-toggle" onClick={() => setOpen((o) => !o)}>
          <span className={open ? "pg-caret open" : "pg-caret"}>
            <IconChevronRight size="1.2rem" />
          </span>
          <span className="pg-title">Preset gallery</span>
        </button>
        <div className="pg-search">
          <IconSearch size="1.4rem" />
          <input
            value={search} placeholder="Search presets"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="pg-count">{(presets ?? []).length} presets</span>
      </div>

      {error && <div className="form-error" style={{ margin: "0 2.4rem 1.6rem" }}>{error}</div>}

      {open && (
        <div className="pg-grid">
          {list.map((p) => {
            const installed = installedUids.has(p.uid);
            return (
              <div key={p.id} className="pg-card" onClick={() => setDetail(p)}>
                <span className="pg-card-name">{p.name}</span>
                <span className="pg-card-meta">{p.fieldCount} fields · {p.description}</span>
                {installed ? (
                  <span className="pg-state">Installed</span>
                ) : (
                  <button
                    className="pg-install" disabled={install.isPending}
                    onClick={(e) => { e.stopPropagation(); runInstall(p); }}
                  >
                    Install
                  </button>
                )}
              </div>
            );
          })}
          {list.length === 0 && <div className="fm-info">No presets match "{search}".</div>}
        </div>
      )}

      {detail && (
        <div className="fm-backdrop" onClick={() => setDetail(null)}>
          <div
            className="fm fm-preset" onClick={(e) => e.stopPropagation()}
            role="dialog" aria-label={detail.name}
          >
            <div className="fm-head fm-head-add">
              <div style={{ flex: 1, minWidth: "0" }}>
                <div className="fm-title">{detail.name}</div>
                <div className="fm-sub">
                  {detail.fieldCount} fields
                  {detail.schemaOrgType && <> · schema:{detail.schemaOrgType}</>}
                  {detail.components.length > 0 && <> · {detail.components.length} component</>}
                </div>
              </div>
              <button className="fm-close" onClick={() => setDetail(null)} aria-label="Close">
                <IconX size="1.3rem" />
              </button>
            </div>
            <div className="pd-body">
              <div className="fm-group-label">Fields it creates</div>
              <div className="pd-list">
                {detail.fields.map((f) => (
                  <div key={f.name} className="pd-row">
                    <FieldTypeTile type={f.type} />
                    <span className="pd-row-name">{f.label ?? f.name}</span>
                    <span className="pd-row-type">{TYPE_LABEL[f.type] ?? f.type}</span>
                    <span style={{ flex: 1 }} />
                    <span className="pd-row-rule">{fieldRuleSummary(f)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="fm-foot">
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
              <span className="fm-foot-spacer" />
              {installedUids.has(detail.uid) ? (
                <span className="pg-state">Installed</span>
              ) : (
                <button
                  className="btn btn-primary" disabled={install.isPending}
                  onClick={() => runInstall(detail)}
                >
                  Install preset
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
