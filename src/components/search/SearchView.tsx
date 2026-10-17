"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchMode } from "@/lib/search/normalize";
import type { PageHit, SearchResult } from "@/lib/search/query";
import type { SnippetPart } from "@/lib/search/snippet";

const PAGE_SIZE = 50;

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: SearchResult; hits: PageHit[]; loadingMore: boolean };

/**
 * The Search page. It sends the query to /api/search and shows what comes
 * back — nothing is computed or guessed here. Results arrive in pages of
 * PAGE_SIZE hits; the document list at the top always covers every match,
 * so nothing is hidden just because it hasn't been loaded yet.
 */
export default function SearchView() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("exact");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  const fetchPage = useCallback(
    async (q: string, m: SearchMode, offset: number, signal: AbortSignal): Promise<SearchResult> => {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, mode: m, offset, limit: PAGE_SIZE }),
        signal,
      });
      if (!res.ok) {
        throw new Error((await res.text()) || `Search failed (HTTP ${res.status})`);
      }
      return (await res.json()) as SearchResult;
    },
    []
  );

  const runSearch = useCallback(
    async (q: string, m: SearchMode) => {
      if (q.trim() === "") return;
      // A newer search always wins: cancel whatever is still in flight.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus({ kind: "loading" });
      try {
        const result = await fetchPage(q, m, 0, controller.signal);
        setStatus({ kind: "done", result, hits: result.hits, loadingMore: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [fetchPage]
  );

  const loadMore = async () => {
    if (status.kind !== "done" || status.loadingMore) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ ...status, loadingMore: true });
    try {
      const next = await fetchPage(status.result.query, status.result.mode, status.hits.length, controller.signal);
      setStatus({ kind: "done", result: next, hits: [...status.hits, ...next.hits], loadingMore: false });
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const changeMode = (m: SearchMode) => {
    setMode(m);
    if (query.trim() !== "") void runSearch(query, m);
  };

  return (
    <div className="flex h-dvh flex-col bg-page">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="rounded-lg px-2 py-1 text-[13px] text-secondary hover:bg-surface-hover hover:text-primary"
        >
          ← Chat
        </Link>
        <h1 className="text-[13px] font-medium text-primary">Search tender documents</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:px-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query, mode);
            }}
            className="flex items-center gap-2 rounded-3xl border border-line bg-surface px-4 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
          >
            <SearchIcon />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={500}
              placeholder="Text to find, e.g. earnest money or 26/2080"
              aria-label="Search text"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-primary outline-none placeholder:text-secondary"
            />
            <button
              type="submit"
              disabled={query.trim() === "" || status.kind === "loading"}
              className="shrink-0 cursor-pointer rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
            >
              Search
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-3 px-1 text-[13px] text-secondary">
            <ModeToggle mode={mode} onChange={changeMode} />
            <span>
              {mode === "exact"
                ? "Punctuation must match: 26-2080 won't find 26/2080."
                : "Punctuation ignored: 26-2080 also finds 26/2080 and 26 2080."}
            </span>
          </div>

          <div className="mt-6">
            <Results status={status} onLoadMore={loadMore} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: SearchMode; onChange: (m: SearchMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Match mode" className="inline-flex rounded-lg border border-line p-0.5">
      {(["exact", "loose"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => onChange(m)}
          className={`cursor-pointer rounded-md px-2.5 py-1 ${
            mode === m ? "bg-surface-hover text-primary" : "text-secondary hover:text-primary"
          }`}
        >
          {m === "exact" ? "Exact" : "Loose"}
        </button>
      ))}
    </div>
  );
}

function Results({ status, onLoadMore }: { status: Status; onLoadMore: () => void }) {
  if (status.kind === "idle") {
    return (
      <p className="px-1 text-[13px] leading-relaxed text-secondary">
        Finds every page that contains the text, across all indexed PDFs. Matching ignores case
        and line breaks. Pages read by OCR are marked, since OCR can misread characters.
      </p>
    );
  }

  if (status.kind === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Searching">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div role="alert" className="rounded-xl border border-line px-4 py-3 text-[13px] text-primary">
        <p className="font-medium">Search didn&apos;t work</p>
        <p className="mt-1 text-secondary">{status.message}</p>
      </div>
    );
  }

  const { result, hits, loadingMore } = status;
  const filenameOnly = result.documents.filter((d) => d.filenameMatch && d.hitCount === 0);

  if (result.totalPages === 0 && filenameOnly.length === 0) {
    return (
      <div className="px-1 text-[13px] text-secondary">
        <p>
          No page contains <span className="text-primary">&ldquo;{result.query}&rdquo;</span>{" "}
          <Timing ms={result.tookMs} />
        </p>
        {result.mode === "exact" && (
          <p className="mt-1">Loose mode ignores punctuation and may find variants.</p>
        )}
      </div>
    );
  }

  // Group the loaded hits by document, keeping the server's order.
  const groups = new Map<number, PageHit[]>();
  for (const hit of hits) groups.set(hit.docId, [...(groups.get(hit.docId) ?? []), hit]);

  return (
    <div className="flex flex-col gap-6">
      <div className="px-1 text-[13px] text-secondary">
        <p>
          {result.totalPages === 0 ? (
            "No page text matches"
          ) : (
            <>
              <span className="text-primary">
                {result.totalPages} {result.totalPages === 1 ? "page" : "pages"}
              </span>{" "}
              in {result.totalDocuments} {result.totalDocuments === 1 ? "document" : "documents"}
            </>
          )}
          {filenameOnly.length > 0 && (
            <>
              {" · "}
              {filenameOnly.length} {filenameOnly.length === 1 ? "document matches" : "documents match"} by
              filename
            </>
          )}{" "}
          <Timing ms={result.tookMs} />
        </p>
        {result.usedFullScan && (
          <p className="mt-1">Short query: every page was scanned, which is slower on a large collection.</p>
        )}
      </div>

      {/* Every matching document, even those whose pages aren't loaded yet. */}
      <ul className="flex flex-col gap-0.5 rounded-xl border border-line p-1.5 text-[13px]">
        {result.documents.map((d) => (
          <li key={d.docId}>
            <a
              href={`#doc-${d.docId}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-hover"
            >
              <span className="min-w-0 flex-1 truncate text-primary" title={d.filename}>
                {d.filename}
              </span>
              {d.filenameMatch && <Badge title="The filename contains the search text">filename</Badge>}
              <span className="shrink-0 tabular-nums text-secondary">
                {d.hitCount} {d.hitCount === 1 ? "page" : "pages"}
              </span>
            </a>
          </li>
        ))}
      </ul>

      {[...groups].map(([docId, docHits]) => (
        <section key={docId} id={`doc-${docId}`} className="scroll-mt-4">
          <h2 className="mb-2 truncate px-1 text-[13px] font-medium text-primary" title={docHits[0].filename}>
            {docHits[0].filename}
          </h2>
          <ol className="flex flex-col gap-2">
            {docHits.map((hit) => (
              <HitRow key={`${hit.docId}-${hit.pageNo}`} hit={hit} />
            ))}
          </ol>
        </section>
      ))}

      {result.hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="cursor-pointer self-center rounded-lg border border-line px-4 py-2 text-[13px] text-primary hover:bg-surface-hover disabled:cursor-wait disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : `Show more pages (${hits.length} of ${result.totalPages} shown)`}
        </button>
      )}
    </div>
  );
}

function HitRow({ hit }: { hit: PageHit }) {
  return (
    <li className="rounded-xl bg-surface px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="font-medium tabular-nums text-primary">Page {hit.pageNo}</span>
        {hit.pageLabel && hit.pageLabel !== String(hit.pageNo) && (
          <span className="text-secondary">printed as {hit.pageLabel}</span>
        )}
        {hit.ocrOnly && (
          <Badge title="Found only in the OCR reading of this page. OCR can misread characters: check the page itself.">
            OCR
          </Badge>
        )}
      </div>
      <p className="text-[14px] leading-relaxed text-secondary">
        <Snippet parts={hit.snippet} />
      </p>
    </li>
  );
}

// Unicode's private-use area: symbol fonts (Wingdings bullets and ticks)
// extract to these code points, which no system font can draw — they'd show
// as empty boxes. Display-only; the stored text and matching are unchanged.
const PRIVATE_USE = new RegExp(
  `[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]+`,
  "g"
);

function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((part, i) => {
        const text = part.text.replace(PRIVATE_USE, "•");
        return part.hit ? (
          <mark key={i} className="rounded-sm bg-highlight px-0.5 text-primary">
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
      className="shrink-0 rounded border border-line px-1.5 py-px text-[11px] uppercase tracking-wide text-secondary"
    >
      {children}
    </span>
  );
}

function Timing({ ms }: { ms: number }) {
  return <span className="tabular-nums">· {ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms</span>;
}

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-secondary"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
