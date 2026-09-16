import type { DisplayMessage } from "@/lib/types";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
  messages: DisplayMessage[];
  /** URLs being fetched for the in-flight turn, or null. */
  fetchingUrls: string[] | null;
}

export default function MessageList({
  messages,
  fetchingUrls,
}: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="text-[15px] text-secondary">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          // Only the streaming message can be in a read phase.
          fetchingUrls={message.isStreaming ? fetchingUrls : null}
        />
      ))}
    </div>
  );
}
