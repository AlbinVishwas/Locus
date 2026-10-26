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
const SOURCE_KEY = "locus.searchSource";
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

let sourceMemory: string | null | undefined;

/** The one source the library search is limited to, or null for all of them. */
export function getSearchSource(): string | null {
  if (typeof window === "undefined") return null;
  if (sourceMemory !== undefined) return sourceMemory;
  try {
    return window.localStorage.getItem(SOURCE_KEY) || null;
  } catch {
    return null;
  }
}

export function setSearchSource(id: string | null): void {
  sourceMemory = id;
  try {
    if (id) window.localStorage.setItem(SOURCE_KEY, id);
    else window.localStorage.removeItem(SOURCE_KEY);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export function useSearchSource(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSearchSource,
    () => null
  );
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
