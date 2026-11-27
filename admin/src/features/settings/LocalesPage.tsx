/**
 * Locales (P11, T2.4) — same card grid as the install wizard's language step.
 * Number = order, 1 = the default language new entries start in.
 *
 * Server rules surfaced as errors rather than hidden: the default cannot be removed,
 * and neither can a locale that still has entries.
 */
import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { api, apiErrorMessage } from "../../api/client";
import { useInvalidatingMutation, useLocales } from "../../hooks/queries";

/** Same candidate list as the install wizard — anything outside it is added as a custom code */
const COMMON_LOCALES: Array<[string, string]> = [
  ["ko", "Korean"], ["en", "English"], ["ja", "Japanese"],
  ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
  ["de", "German"], ["fr", "French"], ["es", "Spanish"],
  ["pt-BR", "Portuguese (Brazil)"], ["it", "Italian"], ["ru", "Russian"],
  ["vi", "Vietnamese"], ["th", "Thai"], ["id", "Indonesian"],
  ["ar", "Arabic"], ["hi", "Hindi"], ["nl", "Dutch"], ["pl", "Polish"],
  ["tr", "Turkish"], ["sv", "Swedish"],
];

/** Mirrors the server's codeSchema (locale/commands.ts) — keep the two in step */
const CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export function LocalesPage() {
  const { data: locales } = useLocales();
  const [custom, setCustom] = useState({ code: "", name: "" });
  const [error, setError] = useState<string | null>(null);

  const onErr = (fallback: string) => (e: unknown) => setError(apiErrorMessage(e, fallback));

  const add = useInvalidatingMutation(
    (v: { code: string; name: string }) => api("/api/locales", { method: "POST", body: v }),
    [["locales"]],
  );
  const remove = useInvalidatingMutation(
    (code: string) => api(`/api/locales/${code}`, { method: "DELETE" }),
    [["locales"]],
  );
  const setDefault = useInvalidatingMutation(
    (code: string) => api(`/api/locales/${code}`, { method: "PATCH", body: { isDefault: true } }),
    [["locales"]],
  );

  const codeOk = CODE_RE.test(custom.code.trim());
  const registered = locales ?? [];
  const byCode = new Map(registered.map((l) => [l.code, l]));
  // Default locale first, the rest in code order
  const order = [
    ...registered.filter((l) => l.isDefault).map((l) => l.code),
    ...registered.filter((l) => !l.isDefault).map((l) => l.code).sort(),
  ];
  // Custom codes outside the preset list get a card too
  const cards: Array<[string, string]> = [
    ...COMMON_LOCALES,
    ...registered.filter((l) => !COMMON_LOCALES.some(([c]) => c === l.code)).map((l) => [l.code, l.name] as [string, string]),
  ];

  return (
    <>
      <div className="page-head"><h1>Locales</h1></div>

      <div className="locale-grid" style={{ maxWidth: "62rem" }}>
        {cards.map(([code, name]) => {
          const row = byCode.get(code);
          const on = !!row;
          const n = order.indexOf(code) + 1;
            const blocked = row?.isDefault
              ? "The default language cannot be removed"
              : row && row.entryCount > 0
                ? `${row.entryCount} entries still use this language`
                : null;
            return (
            <label key={code} className={on ? "locale-card on" : "locale-card"}>
              <input
                type="checkbox" checked={on} disabled={on}
                onChange={() => {
                  if (on) return;
                  setError(null);
                  add.mutate({ code, name }, { onError: onErr("Add failed") });
                }}
              />
              <span className="locale-num">{on ? n : ""}</span>
              <span className="locale-card-text">
                <span className="locale-card-name">{row?.name ?? name}</span>
                <span className="locale-card-code">{code}</span>
              </span>
              {on && (
                <span className="locale-card-action">
                  {row.entryCount > 0 && (
                    <span className="locale-card-used">{row.entryCount}</span>
                  )}
                  {!row.isDefault && (
                    <button
                      type="button" className="btn btn-sm"
                      onClick={(e) => {
                        e.preventDefault();
                        setError(null);
                        setDefault.mutate(code, { onError: onErr("Could not set the default") });
                      }}
                    >
                      Set default
                    </button>
                  )}
                  <button
                    type="button" className="btn btn-ghost btn-icon"
                    disabled={!!blocked} title={blocked ?? `Remove ${row.name}`}
                    aria-label={`Remove ${row.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setError(null);
                      remove.mutate(code, { onError: onErr("Delete failed") });
                    }}
                  >
                    <IconTrash size="1.4rem" />
                  </button>
                </span>
              )}
            </label>
          );
        })}
      </div>

      {error && <div className="form-error" style={{ marginTop: "var(--space-3)", maxWidth: "62rem" }}>{error}</div>}

      <div className="locale-custom">
        <div className="locale-custom-row">
          <input
            className={`mono${custom.code && !CODE_RE.test(custom.code.trim()) ? " invalid" : ""}`}
            placeholder="en-GB" value={custom.code}
            onChange={(e) => setCustom({ ...custom, code: e.target.value })}
          />
          <input
            placeholder="English (UK)" value={custom.name}
            onChange={(e) => setCustom({ ...custom, name: e.target.value })}
          />
          <button
            className="btn btn-primary"
            disabled={!codeOk || !custom.name.trim()}
          onClick={() => {
            setError(null);
            add.mutate(
              { code: custom.code.trim(), name: custom.name.trim() },
              { onSuccess: () => setCustom({ code: "", name: "" }), onError: onErr("Add failed") },
            );
          }}
          >
            <IconPlus size="1.5rem" /> Add
          </button>
        </div>
        <span className="locale-custom-hint">
          Language code, optionally with a region — <code>ko</code>, <code>en-GB</code>,
          <code> pt-BR</code>. Two or three letters, then an optional dash and 2–8 characters.
        </span>
      </div>
    </>
  );
}
