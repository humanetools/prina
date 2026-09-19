/** Light/dark theme (design token [data-theme] scope) — applied to the html root */
import { useCallback, useEffect, useState } from "react";

const KEY = "prina.theme";

export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = localStorage.getItem(KEY) ?? "light";
}

export function useTheme(): { theme: string; setTheme(t: "light" | "dark"): void } {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem(KEY) ?? "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const setTheme = useCallback((t: "light" | "dark") => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);
  return { theme, setTheme };
}
