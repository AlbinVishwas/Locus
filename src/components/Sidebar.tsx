"use client";

import { useConversations } from "./ConversationsProvider";
import ConversationItem from "./ConversationItem";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const MOBILE_QUERY = "(max-width: 767px)";

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const {
    conversations,
    activeConversationId,
    newConversation,
    selectConversation,
  } = useConversations();

  // Newest-active-first: a conversation you're mid-chat with should stay
  // near the top, not just the one you most recently created.
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  const handleSelect = (id: string) => {
    selectConversation(id);
    // On a drawer (mobile width), picking a conversation should also
    // close it — on a persistent desktop column it shouldn't. Checked at
    // click time, not render time, so it's just a plain runtime read with
    // no hydration implications.
    if (typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches) {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop: only ever visible below md, and only when open. */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/50 md:hidden ${
          isOpen ? "block" : "hidden"
        }`}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-[260px] flex-col border-r border-line bg-sidebar transition-transform duration-200 ease-in-out ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } ${isOpen ? "md:translate-x-0" : "md:-translate-x-full"}`}
      >
        <div className="px-3 pt-3 text-[13px] font-medium tracking-wide text-primary">
          Assay
        </div>

        <div className="flex items-center gap-1 p-3">
          <button
            type="button"
            onClick={newConversation}
            className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-primary hover:bg-surface-hover"
          >
            <PlusIcon />
            New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="shrink-0 cursor-pointer rounded-lg p-2 text-secondary hover:bg-surface-hover"
          >
            <PanelIcon />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {sorted.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-secondary">No conversations yet.</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {sorted.map((conversation) => (
                <ConversationItem
                  key={conversation.id}
                  conversation={conversation}
                  isActive={conversation.id === activeConversationId}
                  onSelect={() => handleSelect(conversation.id)}
                />
              ))}
            </div>
          )}
        </nav>
      </aside>
    </>
  );
}

function PlusIcon() {
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
      className="shrink-0"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function PanelIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}
