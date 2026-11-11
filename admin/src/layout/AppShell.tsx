/** 4-tier layout shell — 72px rail / 60px global top bar / Outlet (context panel + main) */
import { Outlet } from "react-router-dom";
import { useLicense } from "../hooks/queries";
import { IconBar } from "./IconBar";
import { TopBar } from "./TopBar";

/** Unpatched warning banner (T8.3) — only when the release feed has a new patch */
function UpdateBanner() {
  const { data } = useLicense();
  const state = data?.state;
  if (!state?.updateAvailable || !state.latestPatch) return null;
  return (
    <div className={`update-banner${state.latestCritical ? " critical" : ""}`}>
      <span className="update-banner-dot" />
      {state.latestCritical
        ? `Critical patch v${state.latestPatch} is available — the updater applies it immediately when enabled.`
        : `Patch v${state.latestPatch} is available — the updater will apply it in the next update window.`}
    </div>
  );
}

export function AppShell() {
  return (
    <div className="app-shell">
      <IconBar />
      <div className="app-body">
        <UpdateBanner />
        <TopBar />
        <div className="app-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
