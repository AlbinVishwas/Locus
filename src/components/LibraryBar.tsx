"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getLibraryStatus, type LibraryStatus } from "@/lib/libraryClient";
import { useFolderScope } from "@/lib/folderScope";
import { setSearchScope, setSearchSource, useSearchScope, useSearchSource } from "@/lib/searchScope";
import { useFeatures } from "./FeaturesProvider";

/**
 * The library's controls, shown only when the library is enabled: where
 * a search looks (my uploads, all sources, one source, or uploads and all
 * sources together) and a status
 * line (documents, pages indexed, still indexing, not indexed, drive
 * connected or not). With the library off this renders nothing at all.
 *
 * The scope picker is a pill (ScopePill) styled exactly like the "Upload
 * documents" and "Find a phrase" chips, so on the empty screen it sits in
 * that row; the status line (LibraryBar with part="status") goes below it.
 * In a conversation LibraryBar shows both together above the composer.
 */

const STATUS_POLL_MS = 30_000;

const n = (x: number) => x.toLocaleString("en-US");

export function statusText(s: LibraryStatus | null): string {
  if (s === null) return "Library: checking…";
  if (!s.connected) return "Library drive not connected";
  return (
    `Library: ${n(s.documents)} ${s.documents === 1 ? "document" : "documents"} · ${n(s.pagesIndexed)} pages indexed · ` +
    `${n(s.indexing)} still indexing · ${n(s.failed)} not indexed · drive connected`
  );
}

function useLibraryStatus(): LibraryStatus | null {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getLibraryStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const timer = setInterval(load, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return status;
}

/** Same look as ChipButton in ChatInput.tsx. */
const PILL =
  "relative flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-secondary hover:border-composer-line hover:text-primary focus-within:border-composer-line focus-within:text-primary";

export default function LibraryBar({ className = "", part = "all" }: { className?: string; part?: "all" | "status" }) {
  const { libraryEnabled } = useFeatures();
  if (!libraryEnabled) return null;
  return <LibraryControls className={className} part={part} />;
}

/** Just the scope picker, as a chip. Renders nothing with the library off. */
export function ScopePill() {
  const { libraryEnabled } = useFeatures();
  if (!libraryEnabled) return null;
  return <ScopeSelect />;
}

const SOURCES_CACHE_KEY = "locus.sourceList";
type SourceList = NonNullable<LibraryStatus["sources"]>;

/**
 * The library's sources for the "Search in" selector. The live list comes with the status poll, so
 * right after a reload there is none yet; the last one seen (per browser, a convenience) fills the gap,
 * so a remembered choice isn't shown as "All sources" for a moment before it settles.
 */
function useRememberedSources(status: LibraryStatus | null): SourceList {
  // A string snapshot, so React sees a stable value; "[]" on the server, the stored list once on the client.
  const raw = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.localStorage.getItem(SOURCES_CACHE_KEY) ?? "[]";
      } catch {
        return "[]";
      }
    },
    () => "[]"
  );
  const cached = useMemo<SourceList>(() => {
    try {
      const v = JSON.parse(raw) as SourceList;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }, [raw]);
  const live = status?.sources;
  useEffect(() => {
    if (!live) return;
    try {
      window.localStorage.setItem(SOURCES_CACHE_KEY, JSON.stringify(live));
    } catch {
      // storage blocked: the list is just fetched again next time
    }
  }, [live]);
  return live ?? cached;
}

function ScopeSelect({ compact = false }: { compact?: boolean }) {
  const { defaultScope = "session", userSources } = useFeatures();
  const mine = userSources === true;
  const scope = useSearchScope(defaultScope);
  const status = useLibraryStatus();
  const source = useSearchSource();
  const sources = useRememberedSources(status);
  // A remembered source that has since been removed falls back to "All sources".
  const known = source !== null && sources.some((x) => x.id === source);
  const value = scope === "session" ? "session" : scope === "both" ? "both" : known ? `source:${source}` : "all";

  const choose = (v: string) => {
    if (v === "session") setSearchScope("session");
    else if (v === "both") {
      setSearchSource(null);
      setSearchScope("both");
    } else if (v === "all") {
      setSearchSource(null);
      setSearchScope("library");
    } else {
      setSearchSource(v.slice("source:".length));
      setSearchScope("library");
    }
  };

  return (
    <label className={compact ? "relative inline-flex items-center gap-1.5 text-[12px] text-secondary focus-within:text-primary hover:text-primary" : PILL}>
      {compact ? <span>Search in</span> : <FolderIcon />}
      <select
        aria-label="Search in"
        data-no-focus-ring
        value={value}
        onChange={(e) => choose(e.target.value)}
        className={`max-w-[60vw] cursor-pointer appearance-none truncate bg-transparent pr-4 [field-sizing:content] text-inherit outline-none ${compact ? "text-[12px] underline decoration-line underline-offset-2" : "text-[13px]"}`}
      >
        <option value="all">{mine ? "All my folders" : "All sources"}</option>
        {sources.length > 0 && (
          <optgroup label={mine ? "One folder" : "One source"}>
            {sources.map((x) => (
              <option key={x.id} value={`source:${x.id}`}>
                {x.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value="session">My uploads</option>
        <option value="both">{mine ? "My uploads and all my folders" : "My uploads and all sources"}</option>
      </select>
      <ChevronIcon compact={compact} />
    </label>
  );
}

function PickedFolderAware() {
  const folder = useFolderScope();
  return folder ? null : <ScopeSelect compact />;
}

function LibraryControls({ className, part }: { className: string; part: "all" | "status" }) {
  const status = useLibraryStatus();
  const disconnected = status !== null && !status.connected;
  const line = (
    <p data-testid="library-status" className={disconnected ? "text-warm" : undefined}>
      {statusText(status)}
    </p>
  );
  if (part === "status") {
    // The scope switch sits on its own line under the status, never over it. A picked folder
    // replaces it: while that chip is up, searches cover that folder only.
    return (
      <div className={`flex flex-col items-center gap-1.5 text-center text-[12px] text-secondary ${className}`}>
        {line}
        <PickedFolderAware />
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px] text-secondary ${className}`}>
      <ScopeSelect />
      {line}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function ChevronIcon({ compact = false }: { compact?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`pointer-events-none absolute shrink-0 ${compact ? "right-0" : "right-2.5"}`}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
