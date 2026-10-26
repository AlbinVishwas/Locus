"use client";

import { useEffect, useState } from "react";
import { getLibraryStatus, type LibraryStatus } from "@/lib/libraryClient";
import { SCOPES, setSearchScope, useSearchScope, type SearchScope } from "@/lib/searchScope";
import { useFeatures } from "./FeaturesProvider";

/**
 * The library's controls, shown only when the library is enabled: where
 * a search looks (this session's files, the library, or both) and a status
 * line (documents, pages indexed, still indexing, not indexed, drive
 * connected or not). With the library off this renders nothing at all.
 */

const LABELS: Record<SearchScope, string> = { session: "This session", library: "Library", both: "Both" };
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

  const disconnected = status !== null && !status.connected;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[12px] text-secondary ${className}`}>
      <div role="radiogroup" aria-label="Search in" className="inline-flex rounded-full border border-line p-0.5">
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={scope === s}
            onClick={() => setSearchScope(s)}
            className={`cursor-pointer rounded-full px-2.5 py-1 transition-colors ${
              scope === s ? "bg-surface text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>
      <p data-testid="library-status" className={disconnected ? "text-warm" : undefined}>
        {statusText(status)}
      </p>
    </div>
  );
}
