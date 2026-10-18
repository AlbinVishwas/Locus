"use client";

import { useState } from "react";
import StageLine from "./StageLine";

interface ThinkingSectionProps {
  reasoning: string;
  reasoningMs: number | null;
  /** True while reasoning_content is arriving but no content token has yet. */
  isThinking: boolean;
  /**
   * URLs currently being fetched server-side, or null. Non-null only during
   * the pre-generation read phase; transient, never part of DisplayMessage.
   */
  fetchingUrls?: string[] | null;
  /**
   * True while this turn's document search has been kicked off but its
   * result hasn't reached the client yet, and before any reasoning has
   * started. Search is near-instant (it's a direct index lookup, not a
   * model call), so this is often too brief to see -- shown when it isn't.
   */
  isSearching?: boolean;
  searchFileCount?: number;
}

/**
 * "Reading example.com..." for one page, "Reading 2 pages..." for several —
 * the full URL is too long and too noisy for a one-line status.
 */
function formatReading(urls: string[]): string {
  if (urls.length > 1) return `Reading ${urls.length} pages...`;

  let host: string;
  try {
    host = new URL(urls[0]).hostname.replace(/^www\./, "");
  } catch {
    // extractUrls only ever emits parseable URLs, so this is belt-and-braces.
    return "Reading page...";
  }
  return `Reading ${host}...`;
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${seconds}s`;
}

export default function ThinkingSection({
  reasoning,
  reasoningMs,
  isThinking,
  fetchingUrls,
  isSearching = false,
  searchFileCount = 0,
}: ThinkingSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const hasReasoning = reasoning.length > 0;

  // The read phase happens before generation, so it takes precedence over
  // "Thinking" — the first reasoning or content token clears it upstream.
  const isReading = !!fetchingUrls?.length;
  const finished = !isReading && !isSearching && !isThinking && reasoningMs !== null;

  const label = isReading
    ? formatReading(fetchingUrls!)
    : isSearching
      ? `Searching ${searchFileCount} ${searchFileCount === 1 ? "file" : "files"}`
      : isThinking
        ? "Thinking…"
        : reasoningMs !== null
          ? formatDuration(reasoningMs)
          : "Thinking…";

  if (finished) {
    return (
      <div className="mb-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasReasoning}
          aria-expanded={hasReasoning ? expanded : undefined}
          className="flex items-center gap-1.5 enabled:cursor-pointer disabled:cursor-default"
        >
          <StageLine state="finished" label={label} />
          {hasReasoning && (
            <ChevronIcon
              className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        {expanded && hasReasoning && (
          <div className="mt-2 whitespace-pre-wrap border-l border-line pl-3 text-[13px] leading-[1.7] text-secondary">
            {reasoning}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mb-2">
      <StageLine state="active" fast={isSearching} label={label} />
    </div>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
