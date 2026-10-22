"use client";

import type { DisplayMessage } from "@/lib/types";
import { useFeatures } from "./FeaturesProvider";
import SearchResultCard from "./SearchResultCard";
import StageLine from "./StageLine";
import ThinkingSection from "./ThinkingSection";
import Markdown from "./Markdown";

interface MessageBubbleProps {
  message: DisplayMessage;
  /** Set only on the assistant message currently streaming. */
  fetchingUrls?: string[] | null;
  /** This conversation's current file count, for the brief "Searching N files" stage. */
  fileCount?: number;
}

export default function MessageBubble({
  message,
  fetchingUrls,
  fileCount = 0,
}: MessageBubbleProps) {
  const { chatEnabled } = useFeatures();

  if (message.role === "user") {
    // Only bubble in the app: subtle fill, right-aligned, width-to-content.
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-[18px] bg-surface px-4 py-2.5 text-[15px] leading-[1.7] text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  if (!chatEnabled) return <SearchOnlyReply message={message} fileCount={fileCount} />;

  // No bubble for the assistant, on purpose — plain full-width text is
  // what makes this read as a chat transcript instead of a message app.
  const isThinking = message.isStreaming && message.content.length === 0;
  const isSearching =
    isThinking && fileCount > 0 && message.searchResult == null && message.reasoning.length === 0;
  const showThinking = message.reasoning.length > 0 || isThinking;

  return (
    <div className="w-full text-left">
      {/* Search runs first, before the model generates anything, so its
          result sits above the reply — the user's own files answering the
          question, not the model describing them. */}
      {message.searchResult && (
        <SearchResultCard result={message.searchResult} looseAlternative={message.looseAlternative} />
      )}
      {message.filesExpired && (
        <p className="mb-3 text-[13px] text-secondary">
          This conversation&apos;s files expired and were removed. Upload them again to search them.
        </p>
      )}
      {showThinking && (
        <ThinkingSection
          reasoning={message.reasoning}
          reasoningMs={message.reasoningMs}
          isThinking={isThinking}
          fetchingUrls={fetchingUrls}
          isSearching={isSearching}
          searchFileCount={fileCount}
        />
      )}
      {message.content.length > 0 && <Markdown>{message.content}</Markdown>}
      {message.failure && (
        // Sits in the assistant slot rather than as a detached line, so the
        // failure reads as the outcome of this turn. Muted, because it is
        // app output rather than something the model said.
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-[1.7] text-secondary">
          {message.failure}
        </p>
      )}
    </div>
  );
}

/**
 * A turn with chat turned off (src/config/features.ts): the search card is
 * the answer. Only the search stage ever shows -- no Thinking, no Writing,
 * since no model runs. Content and failure still render, so a transcript
 * from when chat was on reads the same as it did.
 */
function SearchOnlyReply({ message, fileCount }: { message: DisplayMessage; fileCount: number }) {
  const isSearching = message.isStreaming && message.searchResult == null;

  return (
    <div className="w-full text-left">
      {isSearching && (
        <div className="mb-2">
          <StageLine
            state="active"
            fast
            label={
              fileCount > 0
                ? `Searching ${fileCount} ${fileCount === 1 ? "file" : "files"}`
                : "Searching"
            }
          />
        </div>
      )}
      {message.searchResult && (
        <SearchResultCard
          result={message.searchResult}
          looseAlternative={message.looseAlternative}
          searchOnly
        />
      )}
      {message.noFiles && (
        <p className="mb-3 text-[13px] text-secondary">
          This session has no documents yet. Upload PDFs with the paperclip, or drop them here,
          then type a word or phrase to find it in them.
        </p>
      )}
      {message.filesExpired && (
        <p className="mb-3 text-[13px] text-secondary">
          This session&apos;s files expired and were removed. Upload them again to search them.
        </p>
      )}
      {message.content.length > 0 && <Markdown>{message.content}</Markdown>}
      {message.failure && (
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-[1.7] text-secondary">
          {message.failure}
        </p>
      )}
    </div>
  );
}
