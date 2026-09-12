/**
 * Install intro (design: Prina Intro.dc.html) — the three brand blades assemble in 3D,
 * the wordmark resolves, a hairline fills while it settles, then Start appears (~3.6s).
 *
 * The blade paths are the boxless mark (design/brand/prina-mark.svg) split into one <svg>
 * each, so every blade can carry its own z-depth and delay. Do not re-derive the paths.
 */
import { branding } from "../branding";

const BLADES = [
  {
    key: "a",
    gradient: "introBladeA",
    stops: [
      ["0%", "oklch(0.58 0.2 262)"],
      ["48%", "oklch(0.9 0.05 200)"],
      ["100%", "oklch(0.74 0.16 45)"],
    ],
    coords: { x1: "0.3170", y1: "0.1830", x2: "0.6830", y2: "0.8170" },
    opacity: 0.8,
    d: "M25.45 -2.37L26.32 -2.23L27.02 -1.70L27.46 -0.87L27.56 0.13L24.59 39.78L24.33 40.83L23.75 41.71L22.95 42.29L22.05 42.48L8.50 42.22L7.68 42.00L7.02 41.41L6.61 40.54L6.53 39.52L9.68 1.27L9.93 0.28L10.46 -0.59L11.21 -1.19L12.06 -1.45Z",
  },
  {
    key: "b",
    gradient: "introBladeB",
    stops: [
      ["0%", "oklch(0.96 0.03 220)"],
      ["55%", "oklch(0.56 0.21 266)"],
      ["100%", "oklch(0.88 0.06 180)"],
    ],
    coords: { x1: "0.4251", y1: "0.0749", x2: "0.5749", y2: "0.9251" },
    opacity: 0.9,
    d: "M47.43 6.75L48.44 6.93L49.27 7.53L49.79 8.47L49.92 9.59L46.46 62.30L46.18 63.48L45.52 64.45L44.59 65.07L43.54 65.24L26.08 64.16L25.12 63.87L24.36 63.18L23.88 62.18L23.78 61.03L27.54 10.56L27.81 9.46L28.42 8.51L29.27 7.85L30.24 7.59Z",
  },
  {
    key: "c",
    gradient: "introBladeC",
    stops: [
      ["0%", "oklch(0.94 0.05 205)"],
      ["34%", "oklch(0.62 0.19 258)"],
      ["66%", "oklch(0.84 0.09 190)"],
      ["100%", "oklch(0.86 0.13 62)"],
    ],
    coords: { x1: "0.3666", y1: "0.1334", x2: "0.6334", y2: "0.8666" },
    opacity: 1,
    d: "M76.73 16.20L77.91 16.41L78.90 17.10L79.52 18.16L79.70 19.43L76.07 87.78L75.75 89.10L74.99 90.17L73.90 90.82L72.66 90.96L50.15 88.59L49.05 88.22L48.14 87.40L47.58 86.25L47.44 84.95L51.63 20.08L51.92 18.87L52.61 17.83L53.58 17.12L54.70 16.84Z",
  },
] as const;

export function IntroScreen({ onStart }: { onStart(): void }) {
  return (
    <div className="intro-stage" data-theme="dark">
      <div className="intro-center">
        <div className="intro-col">
          <div className="intro-glow" />

          <div className="intro-scene">
            <div className="intro-cam">
              <div className="intro-idle">
                <div className="intro-mark">
                  {BLADES.map((blade) => (
                    <div key={blade.key} className={`intro-blade ${blade.key}`}>
                      <svg viewBox="0 0 84 84" shapeRendering="geometricPrecision" aria-hidden="true">
                        <defs>
                          <linearGradient id={blade.gradient} {...blade.coords}>
                            {blade.stops.map(([offset, color]) => (
                              <stop key={offset} offset={offset} stopColor={color} />
                            ))}
                          </linearGradient>
                        </defs>
                        {/* Optical centring baked into the mark — same transform as prina-mark.svg */}
                        <g transform="translate(0 -1.8) translate(42 42) scale(0.88) translate(-42 -42)">
                          <path d={blade.d} fill={`url(#${blade.gradient})`} fillOpacity={blade.opacity} />
                        </g>
                      </svg>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="intro-word">{branding.name}</div>

          <div className="intro-action">
            {/* The hairline fills while the mark settles, then fades as Start takes its place */}
            <div className="intro-hairline">
              <i />
            </div>
            <button type="button" className="intro-start" onClick={onStart}>
              Start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
