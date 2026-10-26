"use client";

import { useEffect, useState } from "react";
import { getLibraryStatus, type LibraryStatus } from "@/lib/libraryClient";
import { setSearchScope, setSearchSource, useSearchScope, useSearchSource, type SearchScope } from "@/lib/searchScope";
import { useFeatures } from "./FeaturesProvider";

/**
 * The library's controls, shown only when the library is enabled: where
 * a search looks (my uploads, all sources, one source, or uploads and all
 * sources together) and a status
 * line (documents, pages indexed, still indexing, not indexed, drive
 * connected or not). With the library off this renders nothing at all.
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

export default function LibraryBar({ className = "" }: { className?: string }) {
  const { libraryEnabled, defaultScope = "session" } = useFeatures();
  if (!libraryEnabled) return null;
  return <LibraryControls fallback={defaultScope} className={className} />;
}

function LibraryControls({ fallback, className }: { fallback: SearchScope; className: string }) {
  const scope = useSearchScope(fallback);
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

  const source = useSearchSource();
  const sources = status?.sources ?? [];
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

  const disconnected = status !== null && !status.connected;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px] text-secondary ${className}`}>
      <select
        aria-label="Search in"
        value={value}
        onChange={(e) => choose(e.target.value)}
        className="max-w-full cursor-pointer rounded-full border border-line bg-page px-3 py-1.5 text-[12px] text-primary outline-none hover:bg-surface"
      >
        <option value="all">All sources</option>
        {sources.length > 0 && (
          <optgroup label="One source">
            {sources.map((x) => (
              <option key={x.id} value={`source:${x.id}`}>
                {x.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value="session">My uploads</option>
        <option value="both">My uploads and all sources</option>
      </select>
      <p data-testid="library-status" className={disconnected ? "text-warm" : undefined}>
        {statusText(status)}
      </p>
    </div>
  );
}
