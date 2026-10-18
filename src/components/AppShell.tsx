"use client";

import { useState } from "react";
import Chat from "./Chat";
import Sidebar, { PanelIcon } from "./Sidebar";
import { useConversations } from "./ConversationsProvider";
import { useMediaQuery } from "@/lib/useMediaQuery";

const DESKTOP_QUERY = "(min-width: 768px)";

export default function AppShell() {
  const { activeConversation, updateActiveMessages } = useConversations();

  // Sidebar visibility = an explicit user toggle if one has happened this
  // session, otherwise it follows the viewport: open on desktop, closed
  // (as an overlay drawer) on mobile. `isDesktop` is live — resizing the
  // window across the breakpoint updates it — and it's derived during
  // render, not synced via an effect, so there's no cascading setState.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const isSidebarOpen = manualOverride ?? isDesktop;

  const closeSidebar = () => setManualOverride(false);
  const openSidebar = () => setManualOverride(true);

  return (
    <div className="h-dvh bg-page">
      <Sidebar isOpen={isSidebarOpen} onClose={closeSidebar} />

      {/* Reopen affordance — only rendered while the sidebar is hidden,
          since once it's open there's no room (mobile) or need (desktop)
          for it. */}
      {!isSidebarOpen && (
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open sidebar"
          className="fixed top-3 left-3 z-20 cursor-pointer rounded-lg p-2 text-secondary hover:bg-surface-hover"
        >
          <PanelIcon />
        </button>
      )}

      <div
        className={`h-dvh transition-[margin-left] duration-200 ease-in-out ${
          isSidebarOpen ? "md:ml-[248px]" : "md:ml-0"
        }`}
      >
        <Chat
          key={activeConversation.id}
          conversation={activeConversation}
          onMessagesChange={updateActiveMessages}
        />
      </div>
    </div>
  );
}
