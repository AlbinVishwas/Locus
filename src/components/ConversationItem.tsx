"use client";

import { useEffect, useRef, useState } from "react";
import { useConversations } from "./ConversationsProvider";
import { useFeatures } from "./FeaturesProvider";
import type { Conversation } from "@/lib/types";

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
}

export default function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  const { renameConversation, deleteConversation } = useConversations();
  const { chatEnabled } = useFeatures();
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    setDraftTitle(conversation.title);
    setIsEditing(true);
  };

  const commitRename = () => {
    renameConversation(conversation.id, draftTitle.trim());
    setIsEditing(false);
  };

  const cancelRename = () => {
    setDraftTitle(conversation.title);
    setIsEditing(false);
  };

  const displayTitle = conversation.title || "Untitled";

  // Delete confirmation happens inline, in place of the row's normal
  // content — no modal, per the brief.
  if (isConfirmingDelete) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]"
        onKeyDown={(e) => {
          if (e.key === "Escape") setIsConfirmingDelete(false);
        }}
      >
        <span className="flex-1 truncate text-secondary">{chatEnabled ? "Delete this chat?" : "Delete this session and its files?"}</span>
        <button
          type="button"
          onClick={() => deleteConversation(conversation.id)}
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-primary hover:bg-surface-hover"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={() => setIsConfirmingDelete(false)}
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-secondary hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-1 rounded-lg px-2.5 py-2 text-[13px] ${
        isActive ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              cancelRename();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-primary outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={startEditing}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-primary"
          title={displayTitle}
        >
          {displayTitle}
        </button>
      )}
      {!isEditing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsConfirmingDelete(true);
          }}
          aria-label={chatEnabled ? "Delete conversation" : "Delete session"}
          className="shrink-0 cursor-pointer rounded p-1 text-secondary opacity-0 hover:bg-surface-hover group-hover:opacity-100 focus-visible:opacity-100"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
