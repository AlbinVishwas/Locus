"use client";

import { useSyncExternalStore } from "react";

/**
 * Where a search looks -- this session's files, the document library, or
 * both -- as picked in the scope switch. Per browser (localStorage), a
 * convenience: it starts from LOCUS_SEARCH_SCOPE, and an unreadable or
 * blocked storage simply falls back to that. Only consulted when the
 * library is enabled; with it off every search is a session search, as it
 * always was.
 */

export type SearchScope = "session" | "library" | "both";
export const SCOPES: SearchScope[] = ["session", "library", "both"];

const KEY = "locus.searchScope";
const listeners = new Set<() => void>();
let memory: SearchScope | null = null;

function read(): SearchScope | null {
  if (memory) return memory;
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "session" || v === "library" || v === "both" ? v : null;
  } catch {
    return null;
  }
}

export function getSearchScope(fallback: SearchScope): SearchScope {
  if (typeof window === "undefined") return fallback;
  return read() ?? fallback;
}

export function setSearchScope(scope: SearchScope): void {
  memory = scope;
  try {
    window.localStorage.setItem(KEY, scope);
  } catch {
    // private window, storage blocked: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export function useSearchScope(fallback: SearchScope): SearchScope {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => getSearchScope(fallback),
    () => fallback
  );
}
