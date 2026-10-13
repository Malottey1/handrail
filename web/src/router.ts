import { useSyncExternalStore, type MouseEvent } from "react";

/**
 * Pages: / (home), /login, /signup, /app (the dashboard; tabs use the hash).
 * Handrail serves index.html for any path without a file extension.
 */
const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search + location.hash) return;
  history[opts.replace ? "replaceState" : "pushState"](null, "", to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => location.pathname,
  );
}

/** Props for an <a> that navigates without reloading. */
export function link(to: string) {
  return {
    href: to,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
