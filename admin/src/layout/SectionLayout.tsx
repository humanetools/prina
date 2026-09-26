/** Tier-2 context panel (264px, surface-2) + tier-3 main + tier-4 right panel (336px, Edit only) */
import type { ReactNode } from "react";

export function SectionLayout({
  panelTitle,
  panel,
  panelAction,
  rightPanel,
  children,
}: {
  panelTitle: string;
  panel: ReactNode;
  /** CTA under the panel title (e.g. Create new type — ai-soft button) */
  panelAction?: ReactNode;
  /** Edit-view-only tier-4 panel — attached as a sibling of main (independent scroll) */
  rightPanel?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="section-layout">
      <aside className="context-panel">
        <div className="context-panel-title">{panelTitle}</div>
        {panelAction}
        <div className="context-panel-body">{panel}</div>
      </aside>
      <main className="page-main">{children}</main>
      {rightPanel}
    </div>
  );
}
