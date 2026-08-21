"use client";

import { useState } from "react";

interface ThinkingSectionProps {
  reasoning: string;
  reasoningMs: number | null;
  /** True while reasoning_content is arriving but no content token has yet. */
  isThinking: boolean;
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${seconds}s`;
}

export default function ThinkingSection({
  reasoning,
  reasoningMs,
  isThinking,
}: ThinkingSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const hasReasoning = reasoning.length > 0;

  // Before any reasoning_content has arrived at all, there's nothing to
  // expand yet — the trigger is just a quiet, non-interactive status line.
  const label = isThinking
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
        <span className={isThinking ? "animate-pulse" : undefined}>{label}</span>
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
