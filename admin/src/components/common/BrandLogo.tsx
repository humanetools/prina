/**
 * Brand mark slot — the single place the Prina logo enters the admin UI.
 *
 * Two shipped assets, per the brand handoff:
 *   tile    — `prina-mark-tile.svg`, the primary mark. Brings its own near-black tile and
 *             corner radius, so it sits on any background. The wrapper must not add a
 *             background, border or radius of its own.
 *   boxless — `prina-mark.svg`, glyph only. **Dark surfaces only** — contrast fails on light.
 *
 * The isometric projection is baked into flat paths; the files are shipped as-is, never
 * rebuilt in markup.
 *
 * White-label (T8.5): when BRAND_LOGO_URL is injected the customer logo takes the same footprint.
 */
import { branding } from "../../branding";

/** Sizes verified in the handoff: 128 / 72 / 52 / 40 / 30 / 20 px — i.e. 12.8 / 7.2 / 5.2 / 4 / 3 / 2 rem. */
const ASSETS = {
  tile: `${import.meta.env.BASE_URL}brand/prina-mark-tile.svg`,
  boxless: `${import.meta.env.BASE_URL}brand/prina-mark.svg`,
} as const;

export function BrandLogo({
  size = "4rem",
  variant = "tile",
  className,
}: {
  size?: string;
  /** boxless is only legible on the dark brand surface — see the handoff's don'ts */
  variant?: keyof typeof ASSETS;
  className?: string;
}) {
  return (
    <img
      className={className ? `brand-logo ${className}` : "brand-logo"}
      src={branding.logoUrl ?? ASSETS[variant]}
      alt={branding.name}
      // width/height via CSS — <img> dimension attributes take integer px only and ignore rem
      style={{ width: size, height: size }}
    />
  );
}
