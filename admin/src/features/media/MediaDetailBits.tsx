export function StatusChipList({ items }: { items: string[] }) {
  return (
    <div className="chip-row">
      {items.map((i) => (
        <span key={i} className="chip chip-sm">{i}</span>
      ))}
    </div>
  );
}
