import { useSyncExternalStore } from "react";

/** Light by default; dark when the viewer picks it. Stored per browser. */
export type Theme = "light" | "dark";
const KEY = "handrail.theme";

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let current: Theme = stored();
const listeners = new Set<() => void>();
document.documentElement.dataset.theme = current;

export function setTheme(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered; the choice lasts until reload.
  }
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
}
