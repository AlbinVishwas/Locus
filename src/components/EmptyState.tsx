"use client";

import { useState } from "react";
import type { ConversationFile } from "@/lib/uploadsClient";
import type { InProgressUpload } from "./AttachmentList";
import ChatInput from "./ChatInput";
import ModelPill from "./ModelPill";

interface EmptyStateProps {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  files: ConversationFile[];
  uploading: InProgressUpload[];
  onAttachFiles: (files: File[]) => void;
}

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** New chat, nothing sent yet: a time-of-day greeting over a centered composer, with chip shortcuts into the three things this app actually does. Hooks straight into the same send/attach handlers Chat.tsx already has -- no chat/search/upload logic of its own. */
export default function EmptyState({
  isStreaming,
  onSend,
  onStop,
  files,
  uploading,
  onAttachFiles,
}: EmptyStateProps) {
  // Read once on mount, not on every render -- a conversation left open
  // across midnight doesn't need to relabel itself live. This component
  // only ever renders once hydrated (AppShell, its one caller chain, is
  // all "use client"), so there's no server/client "now" to mismatch.
  const [label] = useState(() => greeting(new Date().getHours()));

  return (
    <div className="flex h-full flex-col">
      {/* Same left reservation as ConversationHeader: AppShell's floating
          reopen button sits at a fixed (12px, 12px) when the sidebar is
          closed. */}
      <div className="flex justify-end py-3 pr-4 pl-14 sm:pr-6">
        <ModelPill />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <h1
          className="mb-8 font-display text-[clamp(32px,8vw,52px)] font-semibold text-warm"
          style={{ letterSpacing: "-0.03em" }}
        >
          {label}
        </h1>
        <ChatInput
          variant="centered"
          isStreaming={isStreaming}
          onSend={onSend}
          onStop={onStop}
          files={files}
          uploading={uploading}
          onAttachFiles={onAttachFiles}
        />
        <p className="mt-6 text-center text-[13px] text-secondary">
          Runs on this laptop. Uploaded files stay private to their conversation.
        </p>
      </div>
    </div>
  );
}
