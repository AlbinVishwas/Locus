"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe, live media query subscription. Server (and the first client
 * hydration pass) always see `false` — matching, so no hydration mismatch
 * — and the real value takes over via React's own re-render-on-mismatch
 * handling for useSyncExternalStore, then stays in sync as the viewport
 * changes.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
