"use client";

import { useState } from "react";
import type { PageHit, SearchResult } from "@/lib/search/query";
import type { SnippetPart } from "@/lib/search/snippet";

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
}

const INITIAL_HITS_PER_DOC = 3;

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
}: SearchResultCardProps) {
  // Showing the loose fallback is a display choice the user makes by
  // clicking, not something the server decides for them.
  const [showLoose, setShowLoose] = useState(false);
  const shown = showLoose && looseAlternative ? looseAlternative : result;

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
            onClick={() => setShowLoose(true)}
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
  for (const hit of shown.hits) groups.set(hit.docId, [...(groups.get(hit.docId) ?? []), hit]);

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
          onClick={() => setShowLoose(false)}
          className="mt-1 cursor-pointer text-secondary underline decoration-line underline-offset-2 hover:decoration-primary"
        >
          Showing matches without exact punctuation — switch back to exact
        </button>
      )}

      <div className="mt-2.5 flex flex-col gap-2.5">
        {[...groups].map(([docId, docHits]) => (
          <DocumentGroup key={docId} filename={docHits[0].filename} hits={docHits} />
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
    </div>
  );
}

function DocumentGroup({ filename, hits }: { filename: string; hits: PageHit[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? hits : hits.slice(0, INITIAL_HITS_PER_DOC);
  const hidden = hits.length - visible.length;

  return (
    <div className="rounded-lg bg-page px-3 py-2.5">
      <p className="mb-1.5 truncate font-medium text-primary" title={filename}>
        {filename}
      </p>
      <ul className="flex flex-col gap-1.5">
        {visible.map((hit) => (
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
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 cursor-pointer text-secondary underline decoration-line underline-offset-2 hover:decoration-primary"
        >
          Show {hidden} more {hidden === 1 ? "page" : "pages"}
        </button>
      )}
    </div>
  );
}

function Snippet({ parts }: { parts: SnippetPart[] }) {
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

function Badge({ children, title }: { children: React.ReactNode; title: string }) {
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
