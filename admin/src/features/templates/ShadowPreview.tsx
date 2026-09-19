/** Shadow DOM preview — same isolation environment as serving mode ③ (T5.3) */
import { useEffect, useRef } from "react";

export function ShadowPreview({
  html,
  css,
  onRendered,
}: {
  html: string;
  css: string;
  /** Fires after paint (fonts ready + rAF) — audit hook point (§0.11) */
  onRendered?(root: ShadowRoot): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    if (!shadowRef.current) {
      shadowRef.current = hostRef.current.attachShadow({ mode: "open" });
    }
    shadowRef.current.innerHTML = `<style>${css}</style>${html}`;

    if (!onRendered) return;
    let cancelled = false;
    const fire = () =>
      requestAnimationFrame(() => {
        if (!cancelled && shadowRef.current) onRendered(shadowRef.current);
      });
    // Font metrics/weights affect contrast thresholds — wait for the font face set
    if (document.fonts?.ready) void document.fonts.ready.then(fire);
    else fire();
    return () => {
      cancelled = true;
    };
  }, [html, css, onRendered]);

  return <div ref={hostRef} className="shadow-preview" />;
}
