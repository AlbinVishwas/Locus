import ModelPill from "./ModelPill";

interface ConversationHeaderProps {
  title: string;
  fileCount: number;
}

/** Pinned above the message list once a conversation has at least one message: its title, how many files it has, and which model is answering. Pure display -- title comes from ConversationsProvider's own auto-titling, unchanged here. */
export default function ConversationHeader({ title, fileCount }: ConversationHeaderProps) {
  return (
    // Left padding is wider than the right: when the sidebar is closed,
    // AppShell floats a reopen button at a fixed (12px, 12px) regardless
    // of what's underneath -- this reserves room for it so the title
    // never sits behind it, on any breakpoint.
    <div className="flex items-center justify-between gap-3 border-b border-line py-3 pr-4 pl-14 sm:pr-6 sm:pl-14">
      <h1
        className="min-w-0 truncate font-display text-[20px] font-semibold text-primary"
        style={{ letterSpacing: "-0.02em" }}
      >
        {title || "New chat"}
      </h1>
      <div className="flex shrink-0 items-center gap-2">
        {fileCount > 0 && (
          <span className="rounded-full border border-line px-2.5 py-1 text-[12px] text-secondary">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
        )}
        {/* The model pill is the least essential thing here -- dropped
            first on a narrow phone width so the title (and the file
            count, which matters more mid-conversation) keep their room. */}
        <ModelPill className="hidden sm:inline-flex" />
      </div>
    </div>
  );
}
