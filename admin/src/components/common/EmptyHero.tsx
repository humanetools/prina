/** Empty-state hero — illustration + guidance copy + CTA (shared by Builder, Content Manager, Media) */
import type { ReactNode } from "react";

export function EmptyHero({
  art,
  title,
  copy,
  actions,
}: {
  art: ReactNode;
  title: string;
  copy: string;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-hero">
      {art}
      <h2>{title}</h2>
      <p>{copy}</p>
      {actions && <div className="empty-hero-actions">{actions}</div>}
    </div>
  );
}

const tileStyle = (hue: number) => ({ "--tile-hue": hue }) as React.CSSProperties;

/** Shared composition: slightly rotated back sheet + straight front sheet (MediaArt feel) */
function StackedCards({ children }: { children: ReactNode }) {
  return (
    <svg className="empty-hero-art" width="22rem" height="15rem" viewBox="0 0 220 150" fill="none">
      <g transform="rotate(-4 90 80)">
        <rect x="44" y="30" width="94" height="88" rx="10" fill="var(--surface-2)" stroke="var(--surface-3)" />
      </g>
      <rect x="84" y="32" width="100" height="96" rx="10" fill="var(--surface-2)" stroke="var(--surface-3)" />
      {children}
    </svg>
  );
}

function Badge({ icon }: { icon: ReactNode }) {
  return (
    <g>
      <rect x="150" y="114" width="46" height="24" rx="12" fill="var(--accent)" />
      {icon}
    </g>
  );
}

/** Content type diagram — colored-tile field rows + add badge (Builder) */
export function TypeCardArt() {
  const row = (y: number, hue: number, barW: number) => (
    <>
      <rect x="98" y={y} width="14" height="14" rx="4" className="hero-tile" style={tileStyle(hue)} />
      <rect x="118" y={y + 4.5} width={barW} height="5" rx="2.5" fill="var(--surface-3)" />
    </>
  );
  return (
    <StackedCards>
      <rect x="98" y="44" width="44" height="6" rx="3" fill="var(--border-strong)" />
      {row(60, 258, 52)}
      {row(82, 152, 40)}
      {row(104, 296, 46)}
      <Badge icon={
        <path d="M173 121v10M168 126h10" stroke="var(--accent-on)" strokeWidth="1.8" strokeLinecap="round" />
      } />
    </StackedCards>
  );
}

/** Entry list diagram — rows + workflow status dots (Content Manager) */
export function EntryListArt() {
  const row = (y: number, barW: number, dot: string) => (
    <>
      <rect x="98" y={y + 2} width="10" height="10" rx="3" fill="var(--surface-3)" />
      <rect x="114" y={y + 4.5} width={barW} height="5" rx="2.5" fill="var(--surface-3)" />
      <circle cx="170" cy={y + 7} r="4" fill={dot} />
    </>
  );
  return (
    <StackedCards>
      <rect x="98" y="44" width="52" height="6" rx="3" fill="var(--border-strong)" />
      {row(60, 40, "var(--draft)")}
      {row(82, 32, "var(--review)")}
      {row(104, 38, "var(--published)")}
      <Badge icon={
        <path d="M168 126h10M174 121.5l4.5 4.5-4.5 4.5"
          stroke="var(--accent-on)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      } />
    </StackedCards>
  );
}

/** Asset tile diagram — image card + upload badge (Media Library) */
export function MediaArt() {
  return (
    <StackedCards>
      <circle cx="110" cy="58" r="7" className="hero-tile" style={tileStyle(96)} />
      <path
        d="M94 114 L120 84 L136 100 L148 88 L175 116"
        stroke="var(--border-strong)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      <Badge icon={
        <path d="M173 131.5v-10M168.5 126l4.5-4.5 4.5 4.5"
          stroke="var(--accent-on)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      } />
    </StackedCards>
  );
}
