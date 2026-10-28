"use client";

import { useState } from "react";
import type { LibraryHit, LibrarySearchResult } from "@/lib/library/query";
import { searchLibraryPage, type LibrarySearchResponse } from "@/lib/libraryClient";
import { Badge, OpenPdf, Snippet } from "./SearchResultCard";

/**
 * One turn's document-library results: the deterministic answer to "where
 * in the library does this appear", straight from the library index. Hits
 * arrive 50 pages at a time; "show more" fetches the next window by cursor,
 * so the browser never holds the whole result. Every way a library search
 * can come back empty gets its own plain message -- the drive not being
 * connected included.
 */

const n = (x: number) => x.toLocaleString("en-US");

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-xl border border-line bg-surface p-3.5 text-[13px] text-secondary">
      <p className="font-medium text-primary">{title}</p>
      {children && <p className="mt-1">{children}</p>}
    </div>
  );
}

export default function LibraryResultCard({ response, failure }: { response?: LibrarySearchResponse | null; failure?: string | null }) {
  if (failure) return <Notice title="Library search failed">{failure}</Notice>;
  if (!response) return null;
  switch (response.status) {
    case "disconnected":
      return <Notice title="Library drive not connected">Plug in the library drive; searches include the library again as soon as it&apos;s back.</Notice>;
    case "empty":
      return <Notice title="Library is empty">Nothing in the library has been indexed yet.</Notice>;
    case "too-short":
      return <Notice title="Too short for the library">Type at least 3 characters to search the library.</Notice>;
    case "ok":
      return <Results initial={response.result} source={response.source ?? null} />;
  }
}

function Results({ initial, source }: { initial: LibrarySearchResult; source: string | null }) {
  const [shown, setShown] = useState<LibrarySearchResult>(initial);
  const [hits, setHits] = useState<LibraryHit[]>(initial.hits);
  const [cursor, setCursor] = useState<number | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = shown.counts ?? initial.counts;

  const fetchWindow = async (result: Pick<LibrarySearchResult, "query" | "mode">, from: number, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const r = await searchLibraryPage(result.query, result.mode, from, source);
      if (r.status !== "ok") {
        setError(r.status === "disconnected" ? "Library drive not connected." : "Couldn't load more results.");
        return;
      }
      if (replace) {
        setShown(r.result);
        setHits(r.result.hits);
      } else {
        setHits((prev) => [...prev, ...r.result.hits]);
      }
      setCursor(r.result.nextCursor);
    } catch {
      setError("Couldn't load more results. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const total = counts?.pages ?? null;
  const exact = counts?.complete ?? true;
  if (hits.length === 0) {
    return (
      <div className="mb-3 rounded-xl border border-line bg-surface p-3.5 text-[13px] text-secondary">
        <p className="mb-1 font-medium text-primary">No matches in the library</p>
        <p>No indexed page in the library contains &ldquo;{shown.query}&rdquo;.</p>
        {shown.mode === "exact" && (initial.looseCount ?? 0) > 0 && (
          <button
            type="button"
            disabled={loading}
            onClick={() => fetchWindow({ query: shown.query, mode: "loose" }, 0, true)}
            className="mt-1 cursor-pointer text-primary underline decoration-line underline-offset-2 hover:decoration-primary"
          >
            {n(initial.looseCount!)} {initial.looseCount === 1 ? "page matches" : "pages match"} without exact punctuation — show them
          </button>
        )}
        {error && <p className="mt-1">{error}</p>}
      </div>
    );
  }

  // Consecutive hits from one document form one group (hits come in document order).
  const groups: Array<{ key: string; hits: LibraryHit[] }> = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last.hits[0].docId === hit.docId) last.hits.push(hit);
    else groups.push({ key: `${hit.docId}-${hit.pageNo}`, hits: [hit] });
  }
  const remaining = total !== null && exact ? total - hits.length : null;

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface p-3.5 text-[13px]" data-testid="library-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-secondary">
        <p>
          <span className="font-medium text-primary">Library</span>
          {counts && (
            <>
              {" · found on "}
              <span className="text-primary">
                {exact ? "" : "at least "}
                {n(counts.pages)} {counts.pages === 1 ? "page" : "pages"}
              </span>{" "}
              in {exact ? "" : "at least "}
              {n(counts.documents)} {counts.documents === 1 ? "document" : "documents"}
            </>
          )}
        </p>
        <span className="tabular-nums">{shown.mode === "exact" ? "Exact" : "Loose"} match</span>
      </div>

      <div className="mt-2.5 flex flex-col gap-2.5">
        {groups.map((g) => (
          <div key={g.key} className="rounded-lg bg-page px-3 py-2.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <p className="truncate font-medium text-primary" title={g.hits[0].displayName}>
                {g.hits[0].displayName}
              </p>
              <span className="flex shrink-0 items-baseline gap-2">
                {g.hits[0].stillIndexing && <Badge title="This document is still being indexed: more of its pages may match later">indexing</Badge>}
                {g.hits[0].sourceName && (
                  <span data-testid="source-chip" className="max-w-[40vw] truncate rounded-full border border-line px-2 py-0.5 text-[11px] text-secondary" title={`Source: ${g.hits[0].sourceName}`}>
                    {g.hits[0].sourceName}
                  </span>
                )}
              </span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {g.hits.map((hit) => (
                <li key={hit.pageNo}>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-secondary">
                    <span className="rounded-full bg-cream/15 px-2 py-0.5 font-medium tabular-nums text-cream">Page {hit.pageNo}</span>
                    {hit.pageLabel && hit.pageLabel !== String(hit.pageNo) && <span>printed as {hit.pageLabel}</span>}
                    {hit.ocrOnly && <Badge title="Found only in the OCR reading — OCR can misread characters">OCR</Badge>}
                    {(hit.sourceKind === "server" || hit.sourceKind === "folder") && <OpenPdf href={`/api/library/file?doc=${hit.docId}`} name={hit.displayName} page={hit.pageNo} />}
                  </div>
                  <p className="leading-relaxed text-secondary">
                    <Snippet parts={hit.snippet} />
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {cursor !== null && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            disabled={loading}
            onClick={() => fetchWindow(shown, cursor, false)}
            className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-primary hover:bg-page disabled:cursor-default disabled:opacity-60"
          >
            {loading
              ? "Loading…"
              : remaining !== null && remaining <= shown.limit
                ? `Show the remaining ${n(remaining)} ${remaining === 1 ? "page" : "pages"}`
                : remaining !== null
                  ? `Show next ${shown.limit} · ${n(remaining)} more pages`
                  : `Show next ${shown.limit}`}
          </button>
          {error && <span className="text-secondary">{error}</span>}
        </div>
      )}
    </div>
  );
}
