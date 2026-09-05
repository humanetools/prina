/** Tier-1 icon rail — design SVG icons as-is (72px, 42px buttons, accent-soft active) */
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
  },
  {
    to: "/mcp", label: "MCP Console",
    icon: (
      <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
        <rect x="4" y="3" width="12" height="9" rx="2" transform="rotate(45 10 10)" />
        <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];

export function IconBar() {
  return (
    <nav className="iconbar">
      {/* App-bar lockup size from the brand handoff: 40px mark */}
      <BrandLogo size="4rem" className="iconbar-brand" />
      {/* EE sections ride above the core menu (adminEe registry; OSS renders nothing) */}
      {(adminEe?.navItems ?? []).map(({ to, label, icon }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            isActive ? "iconbar-item active" : "iconbar-item"
          }
        >
          {icon}
        </NavLink>
      ))}
      {MENU.map(({ to, label, icon }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          className={({ isActive }) =>
            isActive ? "iconbar-item active" : "iconbar-item"
          }
        >
          {icon}
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
        <svg width="2rem" height="2rem" viewBox="0 0 20 20" {...STROKE}>
          <circle cx="10" cy="10" r="6.4" />
          <circle cx="10" cy="10" r="2.2" />
        </svg>
      </NavLink>
    </nav>
  );
}
