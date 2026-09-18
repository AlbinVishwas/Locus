import type { DisplayMessage } from "@/lib/types";
import ThinkingSection from "./ThinkingSection";
import Markdown from "./Markdown";

interface MessageBubbleProps {
  message: DisplayMessage;
  /** Set only on the assistant message currently streaming. */
  fetchingUrls?: string[] | null;
}

export default function MessageBubble({
  message,
  fetchingUrls,
}: MessageBubbleProps) {
  if (message.role === "user") {
    // Only bubble in the app: subtle fill, right-aligned, width-to-content.
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] whitespace-pre-wrap break-words rounded-3xl bg-surface px-4 py-2.5 text-[15px] leading-[1.7] text-primary">
          {message.content}
        </div>
      </div>
    );
  }

  // No bubble for the assistant, on purpose — plain full-width text is
  // what makes this read as a chat transcript instead of a message app.
  const isThinking = message.isStreaming && message.content.length === 0;
  const showThinking = message.reasoning.length > 0 || isThinking;

  return (
    <div className="w-full text-left">
      {showThinking && (
        <ThinkingSection
          reasoning={message.reasoning}
          reasoningMs={message.reasoningMs}
          isThinking={isThinking}
          fetchingUrls={fetchingUrls}
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
