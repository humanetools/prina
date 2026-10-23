/**
 * Analytics events tab (T5.4) — GA4 dataLayer configuration.
 *
 * Layout (2026-08-22 rework): pick an event from the catalog → it appears below as a
 * collapsible card holding everything that event emits — its own event-level parameters,
 * its own items mapping, and the dataLayer snippet it will push. GA4 configures each
 * event independently, so the mapping belongs to the event, not to the bundle.
 * A new card inherits the previous event's items mapping so it need not be retyped.
 */
import { useState } from "react";
import { IconChevronRight, IconTrash } from "@tabler/icons-react";
import {
  GA4_EVENTS,
  GA4_EVENT_PARAMS,
  GA4_ITEM_PARAMS,
  type ContentType,
  type Ga4Config,
} from "../../api/types";

/** Params the official spec types as numbers — mirrors core delivery/ga4.ts */
const NUMERIC = new Set(["price", "quantity", "discount", "index", "tax", "shipping"]);

/**
 * The payload this event will push, with `{field}` standing in for entry values.
 * Mirrors buildGaPayloads in core delivery/ga4.ts — if that changes, change this too.
 */
function snippetFor(
  ev: Ga4Config["events"][number],
  config: Ga4Config,
  fields: string[],
  currency: string,
): string {
  const eventName = ev.event;
  const params = ev.params;
  const itemMapping = ev.itemMapping ?? config.itemMapping;
  const valueField = ev.valueField ?? config.valueField;
  const group = GA4_EVENTS.find((e) => e.name === eventName)?.group ?? "E-commerce";
  const sub = (v: string) => (fields.includes(v) ? `{${v}}` : v);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v) extras[k] = sub(v);

  if (group === "Lead") {
    return JSON.stringify(
      {
        event: eventName,
        currency,
        ...(valueField ? { value: `{${valueField}}` } : {}),
        ...extras,
      },
      null,
      2,
    );
  }
  const item: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(itemMapping)) if (v) item[k] = `{${v}}`;
  return JSON.stringify(
    {
      event: eventName,
      ecommerce: {
        currency,
        ...(group === "E-commerce" && valueField ? { value: `{${valueField}}` } : {}),
        ...extras,
        items: [item],
      },
    },
    null,
    2,
  );
}

function FieldSelect({
  value,
  fields,
  onChange,
  placeholder = "(not mapped)",
}: {
  value: string;
  fields: string[];
  onChange(v: string): void;
  placeholder?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {fields.map((f) => (
        <option key={f} value={f}>{f}</option>
      ))}
    </select>
  );
}

export function AnalyticsEventsTab({
  config,
  onChange,
  contentType,
  workspaceCurrency,
}: {
  config: Ga4Config;
  onChange(next: Ga4Config): void;
  contentType: ContentType;
  workspaceCurrency?: string;
}) {
  const fields = contentType.definition.fields.map((f) => f.name);
  const usedEvents = new Set(config.events.map((e) => e.event));
  const currency = config.currency ?? workspaceCurrency ?? "(unset)";
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setParam = (idx: number, key: string, value: string) =>
    onChange({
      ...config,
      events: config.events.map((e, i) =>
        i === idx ? { ...e, params: { ...e.params, [key]: value } } : e,
      ),
    });

  const setItemParam = (idx: number, key: string, value: string) =>
    onChange({
      ...config,
      events: config.events.map((e, i) => {
        if (i !== idx) return e;
        const next = { ...(e.itemMapping ?? config.itemMapping) };
        if (value) next[key] = value;
        else delete next[key];
        return { ...e, itemMapping: next };
      }),
    });


  return (
    <div className="form-fields">
      <p className="widget-hint">
        Only GA4 <strong>standard events</strong> (no custom namespace). If a required
        parameter is missing, saving is refused — you cannot break the standard even without
        knowing GA4. Global currency: <code>{currency}</code>
      </p>

      {/* Add — the picker sits above the list it feeds */}
      <select
        value=""
        style={{ maxWidth: "36rem" }}
        onChange={(e) => {
          if (!e.target.value) return;
          const prev = config.events[config.events.length - 1];
          onChange({
            ...config,
            events: [
              ...config.events,
              {
                event: e.target.value,
                params: {},
                // inherit so the same item shape need not be retyped per event
                itemMapping: { ...(prev?.itemMapping ?? config.itemMapping) },
                valueField: prev?.valueField ?? config.valueField,
              },
            ],
          });
          setOpen((s) => new Set(s).add(e.target.value));
          e.target.value = "";
        }}
      >
        <option value="">+ Add an event from the GA4 catalog…</option>
        {["E-commerce", "List", "Promotion", "Lead"].map((group) => (
          <optgroup key={group} label={group}>
            {GA4_EVENTS.filter((g) => g.group === group && !usedEvents.has(g.name)).map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.trigger})
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* Event cards */}
      {config.events.length === 0 && (
        <p className="widget-hint">No events yet — nothing is pushed to the dataLayer.</p>
      )}
      {config.events.map((e, i) => {
        const meta = GA4_EVENTS.find((g) => g.name === e.event);
        const spec = GA4_EVENT_PARAMS[e.event] ?? [];
        const isOpen = open.has(e.event);
        const itemMap = e.itemMapping ?? config.itemMapping;
        const missing = [
          ...spec.filter((p) => p.required && !e.params[p.name]).map((p) => p.name),
          ...(meta?.group !== "Lead" && !itemMap.item_id ? ["item_id"] : []),
          ...(meta?.group === "E-commerce" && !(e.valueField ?? config.valueField)
            ? ["value"]
            : []),
        ];
        return (
          <div key={e.event} className={isOpen ? "ga-card open" : "ga-card"}>
            <button className="ga-card-head" onClick={() => toggle(e.event)}>
              <IconChevronRight size="1.4rem" className="ga-caret" />
              <code className="ga-event-name">{e.event}</code>
              <span className="muted">
                {meta?.group} ·{" "}
                {meta?.trigger === "view"
                  ? "auto on render"
                  : `click — data-ga-event="${e.event}"`}
              </span>
              <span style={{ flex: 1 }} />
              {missing.length > 0 && (
                <span className="ga-missing">{missing.join(", ")} unmapped</span>
              )}
              <span
                className="btn btn-ghost btn-icon"
                title="Remove event"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onChange({ ...config, events: config.events.filter((_, j) => j !== i) });
                }}
              >
                <IconTrash size="1.4rem" />
              </span>
            </button>

            {isOpen && (
              <div className="ga-card-body">
                {spec.length > 0 ? (
                  <div className="ga-params">
                    {spec.map((pm) => (
                      <label className="field-inline ga-param" key={pm.name}>
                        <span>
                          <code>{pm.name}</code>
                          {pm.required && <em className="req">*</em>}
                        </span>
                        <FieldSelect
                          value={e.params[pm.name] ?? ""}
                          fields={fields}
                          onChange={(v) => setParam(i, pm.name, v)}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="widget-hint">
                    This event has no extra event-level parameters — it emits currency, value
                    and the items array mapped below.
                  </p>
                )}

                {meta?.group !== "Lead" && (
                  <div>
                    <div className="widget-hint" style={{ fontWeight: 600, marginBottom: "0.6rem" }}>
                      items parameters · value
                    </div>
                    <div className="ga-params">
                      {GA4_ITEM_PARAMS.map((param) => (
                        <label className="field-inline ga-param" key={param}>
                          <span>
                            <code>{param}</code>
                            {param === "item_id" && <em className="req">*</em>}
                            {NUMERIC.has(param) && <span className="muted"> num</span>}
                          </span>
                          <FieldSelect
                            value={itemMap[param] ?? ""}
                            fields={fields}
                            onChange={(v) => setItemParam(i, param, v)}
                          />
                        </label>
                      ))}
                      {meta?.group === "E-commerce" && (
                        <label className="field-inline ga-param">
                          <span>
                            <code>value</code> (total)<em className="req">*</em>
                          </span>
                          <FieldSelect
                            value={e.valueField ?? config.valueField ?? ""}
                            fields={fields}
                            onChange={(v) =>
                              onChange({
                                ...config,
                                events: config.events.map((x, j) =>
                                  j === i ? { ...x, valueField: v || undefined } : x,
                                ),
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                  </div>
                )}

                <div>
                  <div className="widget-hint" style={{ fontWeight: 600, marginBottom: "0.4rem" }}>
                    dataLayer snippet
                  </div>
                  <pre className="ga-snippet">{snippetFor(e, config, fields, currency)}</pre>
                </div>
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}
