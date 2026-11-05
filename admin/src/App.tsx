/** Routing + auth guard (T3.1) */
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { SetupWizardPage } from "./auth/SetupWizardPage";
import { AppShell } from "./layout/AppShell";
import { ContentListPage } from "./features/content-manager/ContentListPage";
import { ContentEditPage } from "./features/content-manager/ContentEditPage";
import { ContentIndexPage } from "./features/content-manager/ContentIndexPage";
import { CtbPage } from "./features/ctb/CtbPage";
import { TaxonomyPage } from "./features/taxonomy/TaxonomyPage";
import { MediaLibraryPage } from "./features/media/MediaLibraryPage";
import { TemplateEditorPage } from "./features/templates/TemplateEditorPage";
import { McpConsolePage } from "./features/mcp/McpConsolePage";
import { ImportWizardPage } from "./features/import/ImportWizardPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { Spinner } from "./components/common/Spinner";
import { adminEe } from "./ee-loader";

export default function App() {
  const { state } = useAuth();

  if (state.status === "loading") {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }
  if (state.status === "setup") return <SetupWizardPage />;
  if (state.status === "anon") return <LoginPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/content" replace />} />
        <Route path="/content" element={<ContentIndexPage />} />
        <Route path="/content/:typeUid" element={<ContentListPage />} />
        <Route path="/content/:typeUid/import" element={<ImportWizardPage />} />
        <Route path="/content/:typeUid/new" element={<ContentEditPage mode="create" />} />
        <Route path="/content/:typeUid/:id" element={<ContentEditPage mode="edit" />} />
        <Route path="/ctb" element={<CtbPage />} />
        <Route path="/ctb/component/:cuid" element={<CtbPage />} />
        <Route path="/ctb/:uid" element={<CtbPage />} />
        <Route path="/templates/:typeUid" element={<TemplateEditorPage />} />
        <Route path="/media" element={<MediaLibraryPage />} />
        <Route path="/taxonomy" element={<TaxonomyPage />} />
        <Route path="/mcp" element={<McpConsolePage />} />
        <Route path="/settings/*" element={<SettingsPage />} />
        {/* EE top-level sections (chatbot) — OSS builds render none */}
        {(adminEe?.navRoutes ?? []).map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {/* the retired Settings › Chatbot deep link keeps working */}
        <Route path="/settings/chatbot" element={<Navigate to="/chatbot" replace />} />
        <Route path="*" element={<Navigate to="/content" replace />} />
      </Route>
    </Routes>
  );
}
