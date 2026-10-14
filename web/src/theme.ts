// Task 36: Club (light) / Slate (dark) theming. Two things decide which
// theme is active: an explicit choice the player made via ThemeToggle
// (persisted in localStorage) and, absent that, the device's own light/dark
// setting (read via prefers-color-scheme). `applyTheme` only ever writes an
// explicit choice onto <html data-theme> -- when there isn't one, the
// attribute is left unset so index.css's prefers-color-scheme media query
// alone decides, which is what keeps "default follows the device setting"
// true even if the device setting changes later in the same session.
export type Theme = "club" | "slate";

const STORAGE_KEY = "chess-dfs:theme";

export function getSavedTheme(): Theme | null {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "club" || value === "slate" ? value : null;
}

export function saveTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme | null): void {
  if (theme === null) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function devicePrefersSlate(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
