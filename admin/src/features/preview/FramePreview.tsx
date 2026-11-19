/**
 * iframe preview at a device width (CM rendered preview, 2026-11-02).
 *
 * The Shadow DOM preview (ShadowPreview) shares the admin's window, so `md:`/`lg:` media queries
 * answer to the browser width, not the preview box. A same-origin `srcdoc` iframe is a real
 * document: `:root`/`html`/`body` and @font-face work untouched, and media queries evaluate at the
 * iframe's own width. Widths wider than the available space are scaled down with a transform, so
 * the layout stays the one a real viewport of that width would get.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PreviewAsset } from "../../api/types";

/** height = the device's screen height: the frame is at least this tall so vh/dvh units mean a real screen */
export const DEVICE_WIDTHS = [
  { key: "fit", label: "Fit", width: 0, height: 0, hint: "the width of this window" },
  { key: "desktop", label: "Desktop", width: 1280, height: 800, hint: "1280 × 800" },
  { key: "tablet", label: "Tablet", width: 768, height: 1024, hint: "768 × 1024" },
  { key: "mobile", label: "Mobile", width: 390, height: 844, hint: "390 × 844" },
] as const;
export type DeviceKey = (typeof DEVICE_WIDTHS)[number]["key"];

const MIN_HEIGHT_PX = 220;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Full document for the iframe: assets (43-IMPL) ahead of the template css, html in body */
export function previewDocument(html: string, css: string, assets: PreviewAsset[] | undefined, head?: string | null): string {
  const live = (assets ?? []).filter((a) => !a.missing && a.body.trim() !== "");
  const styles = live
    .filter((a) => a.as === "css")
    .map((a) => `<style data-preview-asset="${escapeAttr(`${a.type}.${a.field}`)}">${a.body}</style>`)
    .join("\n");
  const sprites = live
    .filter((a) => a.as === "svg")
    .map((a) => `<div hidden data-preview-asset="${escapeAttr(`${a.type}.${a.field}`)}">${a.body}</div>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head ?? ""}
<style>html,body{margin:0}</style>
${styles}
<style data-preview-template>${css}</style>
</head>
<body>
${sprites}
${html}
</body>
</html>`;
}

export function FramePreview({
  html,
  css,
  head,
  assets,
  device,
  onRendered,
  onScale,
}: {
  html: string;
  css: string;
  head?: string | null;
  assets?: PreviewAsset[];
  device: DeviceKey;
  /** Fires after load + fonts + paint — audit hook (same contract as ShadowPreview) */
  onRendered?(root: Document): void;
  /** Reports the scale applied when the device width exceeds the available space (1 = none) */
  onScale?(scale: number): void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [avail, setAvail] = useState(0);
  const [docHeight, setDocHeight] = useState(MIN_HEIGHT_PX);

  const dev = DEVICE_WIDTHS.find((d) => d.key === device);
  const target = dev?.width ?? 0;
  const minHeight = Math.max(dev?.height ?? 0, MIN_HEIGHT_PX);
  const width = target > 0 ? target : avail;
  const scale = target > 0 && avail > 0 && target > avail ? avail / target : 1;

  // Available width = the wrapper's content box
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onScale?.(scale);
  }, [scale, onScale]);

  // Track the document's height so the iframe never scrolls on its own (the modal body does)
  const watchHeight = useCallback((doc: Document) => {
    const update = () => {
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, minHeight);
      setDocHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    if (doc.body) ro.observe(doc.body);
    ro.observe(doc.documentElement);
    return () => ro.disconnect();
  }, [minHeight]);

  const srcdoc = previewDocument(html, css, assets, head);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    let stopHeight: (() => void) | undefined;
    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc || cancelled) return;
      stopHeight = watchHeight(doc);
      if (!onRendered) return;
      const fire = () =>
        requestAnimationFrame(() => {
          if (!cancelled) onRendered(doc);
        });
      if (doc.fonts?.ready) void doc.fonts.ready.then(fire);
      else fire();
    };
    frame.addEventListener("load", onLoad);
    frame.srcdoc = srcdoc;
    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      stopHeight?.();
    };
  }, [srcdoc, onRendered, watchHeight]);

  // Re-measure the document when the frame width changes (reflow → new height)
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc?.body) setDocHeight(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, minHeight));
  }, [width, minHeight]);

  return (
    <div ref={wrapRef} className="frame-preview" data-device={device}>
      <div
        className="frame-preview-stage"
        style={{ width: width ? width * scale : "100%", height: docHeight * scale }}
      >
        <iframe
          ref={frameRef}
          title="Rendered preview"
          className="frame-preview-frame"
          sandbox="allow-same-origin"
          style={{
            width: width || "100%",
            height: docHeight,
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    </div>
  );
}

const DEVICE_KEY = "prina.preview.device";
export function readDevicePref(): DeviceKey {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return DEVICE_WIDTHS.some((d) => d.key === v) ? (v as DeviceKey) : "desktop";
  } catch {
    return "desktop";
  }
}

/** The chosen preview width, remembered per browser (shared by the CM modal and the CTB markup editors) */
export function useDevicePref(): [DeviceKey, (d: DeviceKey) => void] {
  const [device, setDevice] = useState<DeviceKey>(readDevicePref);
  useEffect(() => {
    try { localStorage.setItem(DEVICE_KEY, device); } catch { /* private mode */ }
  }, [device]);
  return [device, setDevice];
}

/** Fit · Desktop · Tablet · Mobile segmented control (+ the scale badge when the frame is shrunk to fit) */
export function DevicePicker({ device, onChange, scale = 1 }: { device: DeviceKey; onChange(d: DeviceKey): void; scale?: number }) {
  return (
    <>
      <div className="seg preview-device" role="group" aria-label="Preview width">
        {DEVICE_WIDTHS.map((d) => (
          <button key={d.key} type="button" className={device === d.key ? "active" : ""} title={d.hint} onClick={() => onChange(d.key)}>
            {d.label}
          </button>
        ))}
      </div>
      {scale < 1 && (
        <span className="widget-hint" title="Scaled to fit — the layout is still the one of the chosen width">
          × {scale.toFixed(2)}
        </span>
      )}
    </>
  );
}
