/** Tier-1 icon rail — design SVG icons as-is (72px, 42px buttons, accent-soft active) */
import type React from "react";
import { NavLink } from "react-router-dom";
import { BrandLogo } from "../components/common/BrandLogo";
import { adminEe } from "../ee-loader";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;

const MENU = [
  {
    to: "/content", label: "Content Manager",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <rect x="3" y="3.5" width="14" height="4" rx="1" />
        <rect x="3" y="10.5" width="14" height="2.4" rx="1" />
        <rect x="3" y="15" width="9" height="2.4" rx="1" />
      </svg>
    ),
    solid: <svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><rect x="3" y="4" width="14" height="2.6" rx="1.3" /><rect x="3" y="8.7" width="14" height="2.6" rx="1.3" /><rect x="3" y="13.4" width="14" height="2.6" rx="1.3" /></svg>,
  },
  {
    to: "/ctb", label: "Content-type Builder",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <rect x="3" y="3" width="6" height="6" rx="1.2" />
        <rect x="11" y="3" width="6" height="6" rx="1.2" />
        <rect x="3" y="11" width="6" height="6" rx="1.2" />
        <rect x="11" y="11" width="6" height="6" rx="1.2" />
      </svg>
    ),
    solid: <svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" /></svg>,
  },
  {
    to: "/media", label: "Media Library",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <rect x="2.6" y="4" width="14.8" height="12" rx="1.5" />
        <circle cx="7" cy="8.4" r="1.5" />
        <path d="M3 14.2 8.4 10l4 3.2 2.4-1.8 2.6 2" />
      </svg>
    ),
    solid: <svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><path d="M5 4h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm7.5 4.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" /></svg>,
  },
  {
    to: "/taxonomy", label: "Taxonomy",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <circle cx="5" cy="4.5" r="1.8" />
        <circle cx="14.5" cy="10" r="1.8" />
        <circle cx="14.5" cy="16" r="1.8" />
        <path d="M5 6.5v9h7.4M5 10h7.4" />
      </svg>
    ),
    solid: <svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h5.4a1.5 1.5 0 0 1 1.06.44l5.6 5.6a1.5 1.5 0 0 1 0 2.12l-5 5a1.5 1.5 0 0 1-2.12 0l-5.6-5.6A1.5 1.5 0 0 1 3 9.5ZM7.6 6.4a1.2 1.2 0 1 0-2.4 0 1.2 1.2 0 0 0 2.4 0Z" /></svg>,
  },
  {
    to: "/mcp", label: "MCP Console",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <rect x="4" y="3" width="12" height="9" rx="2" transform="rotate(45 10 10)" />
        <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    ),
    solid: <svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><rect x="5" y="5" width="10" height="10" rx="2.2" transform="rotate(45 10 10)" /></svg>,
  },
];

/**
 * Line + solid pair (2026-11-14): OSS shows the line icon; the EE/Cloud theme (src/ee/ee-theme.css)
 * swaps in the solid one. A missing solid variant keeps the line icon everywhere.
 */
function RailIcon({ line, solid }: { line: React.ReactNode; solid?: React.ReactNode }) {
  if (!solid) return <>{line}</>;
  return (
    <>
      <span className="rail-ico rail-ico-line">{line}</span>
      <span className="rail-ico rail-ico-solid">{solid}</span>
    </>
  );
}

export function IconBar() {
  // EE decides per item whether it exists on this instance (e.g. Flow Web behind PRINA_FLOW_WEB);
  // the hook identity is fixed per build, so calling it conditionally on adminEe is stable
  const visible = adminEe?.useNavItemVisible?.() ?? (() => true);
  return (
    <nav className="iconbar">
      {/* App-bar lockup size from the brand handoff: 40px mark */}
      <BrandLogo size="3.2rem" className="iconbar-brand" />
      {/* EE sections ride above the core menu (adminEe registry; OSS renders nothing) */}
      {(adminEe?.navItems ?? []).filter(({ to }) => visible(to)).map(({ to, label, icon, iconSolid }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            isActive ? "iconbar-item active" : "iconbar-item"
          }
        >
          <RailIcon line={icon} solid={iconSolid} />
        </NavLink>
      ))}
      {MENU.map(({ to, label, icon, solid }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            isActive ? "iconbar-item active" : "iconbar-item"
          }
        >
          <RailIcon line={icon} solid={solid} />
        </NavLink>
      ))}
      <div className="iconbar-spacer" />
      <NavLink
        to="/settings"
        title="Settings"
        className={({ isActive }) =>
          isActive ? "iconbar-item active" : "iconbar-item"
        }
      >
        <RailIcon
          line={
            <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
              <circle cx="10" cy="10" r="6.4" />
              <circle cx="10" cy="10" r="2.2" />
            </svg>
          }
          solid={<svg width="2rem" height="2rem" viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd"><path d="M16.5 10a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0ZM12.4 10a2.4 2.4 0 1 0-4.8 0 2.4 2.4 0 0 0 4.8 0Z" /></svg>}
        />
      </NavLink>
    </nav>
  );
}
