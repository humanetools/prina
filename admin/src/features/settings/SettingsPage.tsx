/** Settings group (P11, T3.5) — child routing */
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { SectionLayout } from "../../layout/SectionLayout";
import { AccountPage } from "./AccountPage";
import { UsersPage } from "./UsersPage";
import { RolesPage } from "./RolesPage";
import { LocalesPage } from "./LocalesPage";
import { SystemPage } from "./SystemPage";
import { AiPage } from "./AiPage";
import { adminEe } from "../../ee-loader";

// EE items (workflow guard, audit) come from the registry — not included in OSS builds (IMPL-ee-boundary)
const ITEMS = [
  { to: "account", label: "My account" },
  { to: "users", label: "Users" },
  { to: "roles", label: "Roles" },
  { to: "locales", label: "Locales" },
  { to: "ai", label: "AI" },
  ...(adminEe?.settingsItems ?? []),
  { to: "system", label: "System" },
];

export function SettingsPage() {
  const panel = (
    <div className="nav-group">
      {ITEMS.map((i) => (
        <NavLink key={i.to} to={i.to}
          className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}>
          {i.label}
        </NavLink>
      ))}
    </div>
  );

  return (
    <SectionLayout panelTitle="Settings" panel={panel}>
      <Routes>
        <Route index element={<Navigate to="account" replace />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="users-roles" element={<Navigate to="../users" replace />} />
        <Route path="locales" element={<LocalesPage />} />
        <Route path="ai" element={<AiPage />} />
        <Route path="system" element={<SystemPage />} />
        {(adminEe?.settingsRoutes ?? []).map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
      </Routes>
    </SectionLayout>
  );
}
