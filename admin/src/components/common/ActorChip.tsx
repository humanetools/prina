/** Human vs AI actor (design §2.3) — inline SVG (robot/person); AI uses the ai-soft pill */
import { ActorType } from "../../api/types";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;

export function ActorIcon({ isAi }: { isAi: boolean }) {
  return (
    <svg width="1.2rem" height="1.2rem" viewBox="0 0 12 12" {...S}>
      {isAi ? (
        <g>
          <rect x="2" y="3.4" width="8" height="6.2" rx="1.6" />
          <path d="M6 3.4V1.6M4.3 6.2h.01M7.7 6.2h.01" />
        </g>
      ) : (
        <g>
          <circle cx="6" cy="4.3" r="2.1" />
          <path d="M2.4 10.4c.7-2 2-3 3.6-3s2.9 1 3.6 3" />
        </g>
      )}
    </svg>
  );
}

export function ActorChip({
  actorType,
  label,
}: {
  actorType: ActorType | string;
  label?: string | null;
}) {
  const isAi = actorType === ActorType.Ai;
  if (isAi) {
    return (
      <span className="actor actor-ai" title="AI agent">
        <ActorIcon isAi />
        {label && <code>{label}</code>}
      </span>
    );
  }
  if (actorType === ActorType.System) {
    return (
      <span className="actor actor-system" title="System">
        <ActorIcon isAi={false} />
        {label ?? "system"}
      </span>
    );
  }
  return (
    <span className="actor actor-human" title="User">
      <ActorIcon isAi={false} />
      {label ?? ""}
    </span>
  );
}
