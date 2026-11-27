export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? "spinner spinner-sm" : "spinner"} aria-label="Loading" />;
}
