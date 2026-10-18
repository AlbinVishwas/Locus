import type { DisplayMessage } from "@/lib/types";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
  messages: DisplayMessage[];
  /** URLs being fetched for the in-flight turn, or null. */
  fetchingUrls: string[] | null;
  /** This conversation's current file count, for the brief "Searching N files" stage. */
  fileCount: number;
}

export default function MessageList({
  messages,
  fetchingUrls,
  fileCount,
}: MessageListProps) {
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 py-8 sm:px-6">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          // Only the streaming message can be in a read phase.
          fetchingUrls={message.isStreaming ? fetchingUrls : null}
          fileCount={fileCount}
        />
      ))}
    </div>
  );
}
