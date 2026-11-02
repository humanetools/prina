/** Entry slot for later-Phase screens — honest status display in the icon bar */
import { IconClockCog } from "@tabler/icons-react";

export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="page-main">
      <div className="empty-state">
        <IconClockCog size="4rem" stroke={1.2} />
        <h2>{title}</h2>
        <p>{phase} provides this.</p>
      </div>
    </div>
  );
}
