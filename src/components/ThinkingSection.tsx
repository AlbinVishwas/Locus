"use client";

import { useState } from "react";

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
}: ThinkingSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const hasReasoning = reasoning.length > 0;

  // The read phase happens before generation, so it takes precedence over
  // "Thinking" — the first reasoning or content token clears it upstream.
  const isReading = !!fetchingUrls?.length;

  // Before any reasoning_content has arrived at all, there's nothing to
  // expand yet — the trigger is just a quiet, non-interactive status line.
  const label = isReading
    ? formatReading(fetchingUrls!)
    : isThinking
      ? "Thinking"
      : reasoningMs !== null
        ? formatDuration(reasoningMs)
        : "Thinking";

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!hasReasoning}
        className="flex items-center gap-1.5 text-[13px] text-secondary enabled:cursor-pointer disabled:cursor-default"
      >
        {/* Subtle breathing opacity while streaming — deliberately not a
            spinner, per the brief. */}
        <span className={isThinking || isReading ? "animate-pulse" : undefined}>
          {label}
        </span>
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
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
