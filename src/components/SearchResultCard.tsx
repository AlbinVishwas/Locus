"use client";

import { useState } from "react";
import type { PageHit, SearchResult } from "@/lib/search/query";
import type { SnippetPart } from "@/lib/search/snippet";
import { searchSessionPage } from "@/lib/sessionSearchClient";

interface SearchResultCardProps {
  result: SearchResult;
  /** The punctuation-insensitive fallback, when exact mode found nothing but loose mode found something. */
  looseAlternative?: SearchResult | null;
  /**
   * Chat turned off: the card is the turn's whole answer, so "nothing
   * found" gets a full card with a clear heading instead of the quiet line
   * that sits above a model reply.
   */
  searchOnly?: boolean;
  /**
   * The session the search ran in. Enables "show more": the server sends
   * hits in windows of `result.limit`, and without this the card can only
   * show the first window.
   */
  conversationId?: string;
}

// Unicode private-use area: symbol-font bullets (Wingdings etc.) extract to
// these code points, which no system font can draw. Display-only.
const PRIVATE_USE = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]+`, "g");

/**
 * The deterministic "does a document mention this" card for one chat turn.
 * Everything here comes straight from search() — see documentSearch.ts —
 * never from the model. Rendered above the model's own reply (search runs
 * first), and kept on DisplayMessage so it survives a reload; never sent
 * back to the model (toHistoryPayload only ever reads {role, content}).
 */
export default function SearchResultCard({
  result,
  looseAlternative,
  searchOnly = false,
  conversationId,
}: SearchResultCardProps) {
  // Showing the loose fallback is a display choice the user makes by
  // clicking, not something the server decides for them.
  const [showLoose, setShowLoose] = useState(false);
  const shown = showLoose && looseAlternative ? looseAlternative : result;

  // Hits fetched past the first window. Kept in memory only (not on the
  // stored message), so a reload shows the first window again.
  const [moreHits, setMoreHits] = useState<PageHit[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const allHits = [...shown.hits, ...moreHits];
  const remaining = shown.totalPages - shown.offset - allHits.length;

  const switchMode = (loose: boolean) => {
    setShowLoose(loose);
    setMoreHits([]);
    setMoreError(null);
  };

  const loadMore = async () => {
    if (!conversationId || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await searchSessionPage(
        conversationId,
        shown.query,
        shown.mode,
        shown.offset + allHits.length
      );
      if (page.status === "ok") {
        setMoreHits((prev) => [...prev, ...page.result.hits]);
      } else {
        setMoreError("This session's files are no longer available.");
      }
    } catch {
      setMoreError("Couldn't load more results. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  const filenameOnly = shown.documents.filter((d) => d.filenameMatch && d.hitCount === 0);
  const nothingFound = shown.totalPages === 0 && filenameOnly.length === 0;

  if (nothingFound) {
    return (
      <div
        className={
          searchOnly
            ? "mb-3 rounded-xl border border-line bg-surface p-3.5 text-[13px] text-secondary"
            : "mb-3 text-[13px] text-secondary"
        }
      >
        {searchOnly && <p className="mb-1 font-medium text-primary">No matches in your files</p>}
        <p>
          No page in this {searchOnly ? "session" : "conversation"}&apos;s files contains &ldquo;
          {shown.query}&rdquo;.
        </p>
        {!showLoose && looseAlternative && (
          <button
            type="button"
            onClick={() => switchMode(true)}
            className="mt-1 cursor-pointer text-primary underline decoration-line underline-offset-2 hover:decoration-primary"
          >
            {looseAlternative.totalPages} {looseAlternative.totalPages === 1 ? "page" : "pages"} match
            without exact punctuation — show them
          </button>
        )}
      </div>
    );
  }

  const groups = new Map<number, PageHit[]>();
  for (const hit of allHits) groups.set(hit.docId, [...(groups.get(hit.docId) ?? []), hit]);
  const hitCountByDoc = new Map(shown.documents.map((d) => [d.docId, d.hitCount]));
  // Documents with matches that sit past the loaded hits: listed by name
  // and count so the header's document total is visible, not just stated.
  const notYetShown = shown.documents.filter((d) => d.hitCount > 0 && !groups.has(d.docId));

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface p-3.5 text-[13px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-secondary">
        <p>
          Found on{" "}
          <span className="text-primary">
            {shown.totalPages} {shown.totalPages === 1 ? "page" : "pages"}
          </span>{" "}
          in {shown.totalDocuments} {shown.totalDocuments === 1 ? "document" : "documents"}
          {filenameOnly.length > 0 && (
            <>
              {" · "}
              {filenameOnly.length} by filename
            </>
          )}
        </p>
        <span className="tabular-nums">
          {shown.mode === "exact" ? "Exact" : "Loose"} match · {formatMs(shown.tookMs)}
        </span>
      </div>

      {showLoose && (
        <button
          type="button"
          onClick={() => switchMode(false)}
          className="mt-1 cursor-pointer text-secondary underline decoration-line underline-offset-2 hover:decoration-primary"
        >
          Showing matches without exact punctuation — switch back to exact
        </button>
      )}

      <div className="mt-2.5 flex flex-col gap-2.5">
        {[...groups].map(([docId, docHits]) => (
          <DocumentGroup
            key={docId}
            filename={docHits[0].filename}
            hits={docHits}
            totalHits={hitCountByDoc.get(docId) ?? docHits.length}
          />
        ))}
        {notYetShown.map((d) => (
          <div key={d.docId} className="flex items-baseline justify-between gap-3 rounded-lg bg-page px-3 py-2">
            <span className="truncate font-medium text-primary" title={d.filename}>
              {d.filename}
            </span>
            <span className="shrink-0 text-secondary">
              {d.hitCount} {d.hitCount === 1 ? "page" : "pages"} · not loaded yet
            </span>
          </div>
        ))}
        {filenameOnly.map((d) => (
          <div key={d.docId} className="rounded-lg bg-page px-3 py-2">
            <span className="truncate text-primary" title={d.filename}>
              {d.filename}
            </span>
            <span className="ml-2 text-secondary">matches by filename only</span>
          </div>
        ))}
      </div>

      {remaining > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {conversationId ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-primary hover:bg-page disabled:cursor-default disabled:opacity-60"
            >
              {loadingMore
                ? "Loading…"
                : remaining <= shown.limit
                  ? `Show the remaining ${remaining} ${remaining === 1 ? "page" : "pages"}`
                  : `Show next ${shown.limit} · ${remaining} more pages`}
            </button>
          ) : (
            <span className="text-secondary">
              Showing {allHits.length} of {shown.totalPages} pages
            </span>
          )}
          {moreError && <span className="text-secondary">{moreError}</span>}
        </div>
      )}
    </div>
  );
}

function DocumentGroup({ filename, hits, totalHits }: { filename: string; hits: PageHit[]; totalHits: number }) {
  return (
    <div className="rounded-lg bg-page px-3 py-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <p className="truncate font-medium text-primary" title={filename}>
          {filename}
        </p>
        <span className="shrink-0 tabular-nums text-secondary">
          {hits.length < totalHits ? `${hits.length} of ${totalHits} pages` : `${totalHits} ${totalHits === 1 ? "page" : "pages"}`}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {hits.map((hit) => (
          <li key={hit.pageNo}>
            <div className="flex flex-wrap items-baseline gap-x-2 text-secondary">
              <span className="rounded-full bg-cream/15 px-2 py-0.5 font-medium tabular-nums text-cream">
                Page {hit.pageNo}
              </span>
              {hit.pageLabel && hit.pageLabel !== String(hit.pageNo) && (
                <span>printed as {hit.pageLabel}</span>
              )}
              {hit.ocrOnly && <Badge title="Found only in the OCR reading — OCR can misread characters">OCR</Badge>}
            </div>
            <p className="leading-relaxed text-secondary">
              <Snippet parts={hit.snippet} />
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((part, i) => {
        const text = part.text.replace(PRIVATE_USE, "•");
        return part.hit ? (
          <mark key={i} className="rounded-sm bg-cream/25 px-0.5 text-warm">
            {text}
          </mark>
        ) : (
          <span key={i}>{text}</span>
        );
      })}
    </>
  );
}

export function Badge({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded border border-line px-1 py-px text-[11px] uppercase tracking-wide text-secondary"
    >
      {children}
    </span>
  );
}

function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}
