import type { DisplayMessage } from "@/lib/types";
import ThinkingSection from "./ThinkingSection";

interface MessageBubbleProps {
  message: DisplayMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
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
        />
      )}
      {message.content.length > 0 && (
        <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.7] text-primary">
          {message.content}
        </p>
      )}
    </div>
  );
}
