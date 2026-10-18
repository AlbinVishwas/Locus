"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  EMPTY_CONVERSATION,
  createEmptyConversation,
  deriveTitle,
} from "@/lib/conversations";
import { loadConversations, saveConversations } from "@/lib/storage";
import { generateSmartTitle } from "@/lib/titleClient";
import type { Conversation, DisplayMessage } from "@/lib/types";
import { deleteConversationFiles } from "@/lib/uploadsClient";

const PERSIST_DEBOUNCE_MS = 500;

interface State {
  conversations: Conversation[];
  activeConversationId: string | null;
  isHydrated: boolean;
}

type Action =
  | { type: "hydrate"; conversations: Conversation[] }
  | { type: "create" }
  | { type: "select"; id: string }
  | { type: "delete"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "updateMessages"; id: string; messages: DisplayMessage[] }
  | { type: "upgradeTitle"; id: string; title: string };

const initialState: State = {
  conversations: [],
  activeConversationId: null,
  isHydrated: false,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "hydrate": {
      if (action.conversations.length > 0) {
        return {
          conversations: action.conversations,
          activeConversationId: action.conversations[0].id,
          isHydrated: true,
        };
      }
      const fresh = createEmptyConversation();
      return {
        conversations: [fresh],
        activeConversationId: fresh.id,
        isHydrated: true,
      };
    }

    case "create": {
      const fresh = createEmptyConversation();
      return {
        ...state,
        conversations: [fresh, ...state.conversations],
        activeConversationId: fresh.id,
      };
    }

    case "select":
      return { ...state, activeConversationId: action.id };

    case "delete": {
      const remaining = state.conversations.filter((c) => c.id !== action.id);
      if (remaining.length === 0) {
        // Never leave the sidebar with zero conversations — reset to a
        // single fresh one instead.
        const fresh = createEmptyConversation();
        return { ...state, conversations: [fresh], activeConversationId: fresh.id };
      }
      const activeConversationId =
        state.activeConversationId === action.id
          ? remaining[0].id
          : state.activeConversationId;
      return { ...state, conversations: remaining, activeConversationId };
    }

    case "rename": {
      // A title the user set by hand is never touched again -- not by the
      // first-message fallback (title is already non-empty) and not by a
      // later model-generated upgrade (see "upgradeTitle" below).
      const conversations = state.conversations.map((c) =>
        c.id === action.id
          ? { ...c, title: action.title, titleSource: "manual" as const, updatedAt: Date.now() }
          : c
      );
      return { ...state, conversations };
    }

    case "updateMessages": {
      const conversations = state.conversations.map((c) => {
        if (c.id !== action.id) return c;
        // The fast local fallback fires once, from the first user
        // message, and never again -- an existing title is never
        // overwritten here. The real phrase (see "upgradeTitle") arrives
        // asynchronously, from a separate call the caller kicks off.
        if (c.title) return { ...c, messages: action.messages, updatedAt: Date.now() };
        return {
          ...c,
          messages: action.messages,
          title: deriveTitle(action.messages),
          titleSource: "auto-raw" as const,
          updatedAt: Date.now(),
        };
      });
      return { ...state, conversations };
    }

    case "upgradeTitle": {
      const conversations = state.conversations.map((c) => {
        // Skip a conversation that was renamed by hand, or already has
        // the smart title, while this request was in flight.
        if (c.id !== action.id || c.titleSource === "manual" || c.titleSource === "auto-smart") {
          return c;
        }
        return { ...c, title: action.title, titleSource: "auto-smart" as const };
      });
      return { ...state, conversations };
    }

    default:
      return state;
  }
}

interface ConversationsContextValue {
  /** Not sorted — the sidebar decides display order (newest-active-first). */
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversation: Conversation;
  isHydrated: boolean;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  updateActiveMessages: (messages: DisplayMessage[]) => void;
}

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

export function ConversationsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Fire-and-forget: asks the model for a short topic phrase for a
  // conversation's first message, then upgrades its title once that
  // comes back (see the "upgradeTitle" reducer case, which skips a
  // conversation renamed by hand in the meantime). A slow or unreachable
  // LM Studio just means the fast local title (deriveTitle) stands as the
  // permanent one -- never a blocked sidebar.
  //
  // Deduped per id for the life of this provider, in a ref rather than
  // state the request itself is never rendered: updateActiveMessages
  // below fires on every streamed token, and without this a burst of
  // calls before conversationsRef catches up to the just-dispatched title
  // would otherwise request the same upgrade many times over.
  const requestedTitleUpgradeIds = useRef(new Set<string>());
  const requestTitleUpgrade = useCallback((id: string, firstMessage: string) => {
    if (requestedTitleUpgradeIds.current.has(id)) return;
    requestedTitleUpgradeIds.current.add(id);
    generateSmartTitle(firstMessage).then((title) => {
      if (title) dispatch({ type: "upgradeTitle", id, title });
    });
  }, []);

  // Read localStorage only after mount, never during render. The first
  // render (server + first client hydration pass) always shows the empty
  // initialState above, so there's nothing for hydration to mismatch —
  // real data arrives one tick later via a normal client-side update.
  useEffect(() => {
    const loaded = loadConversations();
    dispatch({ type: "hydrate", conversations: loaded });

    // Retroactively upgrades any conversation still on its raw-text
    // title -- including every one saved before this feature existed,
    // which has no titleSource at all and so reads the same as
    // "auto-raw" here. Runs once per load, not on every render: this
    // effect has an empty dependency array.
    for (const c of loaded) {
      if (c.titleSource === "manual" || c.titleSource === "auto-smart") continue;
      const firstUser = c.messages.find((m) => m.role === "user");
      if (firstUser) requestTitleUpgrade(c.id, firstUser.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced persistence: token-by-token streaming updates conversations
  // in memory constantly, but we only want to hit localStorage once things
  // settle (in practice: at or shortly after each message completes), not
  // on every chunk.
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.isHydrated) return; // don't clobber storage with empty initial state
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      saveConversations(state.conversations);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    };
  }, [state.conversations, state.isHydrated]);

  const newConversation = useCallback(() => dispatch({ type: "create" }), []);
  const selectConversation = useCallback((id: string) => dispatch({ type: "select", id }), []);
  const deleteConversation = useCallback((id: string) => {
    dispatch({ type: "delete", id });
    // Fire-and-forget: the conversation disappears from the sidebar
    // immediately regardless of how long server-side cleanup takes, and a
    // failed request here (server unreachable, say) shouldn't block the
    // local delete the user actually asked for.
    void deleteConversationFiles(id);
  }, []);
  const renameConversation = useCallback(
    (id: string, title: string) => dispatch({ type: "rename", id, title }),
    []
  );

  const activeConversationIdRef = useRef(state.activeConversationId);
  useEffect(() => {
    activeConversationIdRef.current = state.activeConversationId;
  }, [state.activeConversationId]);
  // Mirrors state.conversations the same way activeConversationIdRef
  // mirrors activeConversationId: so updateActiveMessages (called on every
  // streamed token) can check "did this conversation already have a
  // title" without needing state in its own dependency array.
  const conversationsRef = useRef(state.conversations);
  useEffect(() => {
    conversationsRef.current = state.conversations;
  }, [state.conversations]);
  const updateActiveMessages = useCallback(
    (messages: DisplayMessage[]) => {
      const id = activeConversationIdRef.current;
      if (!id) return;
      const hadTitle = !!conversationsRef.current.find((c) => c.id === id)?.title;
      dispatch({ type: "updateMessages", id, messages });
      if (!hadTitle) {
        const firstUser = messages.find((m) => m.role === "user");
        if (firstUser) requestTitleUpgrade(id, firstUser.content);
      }
    },
    [requestTitleUpgrade]
  );

  const activeConversation =
    state.conversations.find((c) => c.id === state.activeConversationId) ??
    EMPTY_CONVERSATION;

  const value = useMemo<ConversationsContextValue>(
    () => ({
      conversations: state.conversations,
      activeConversationId: state.activeConversationId,
      activeConversation,
      isHydrated: state.isHydrated,
      newConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      updateActiveMessages,
    }),
    [
      state.conversations,
      state.activeConversationId,
      activeConversation,
      state.isHydrated,
      newConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      updateActiveMessages,
    ]
  );

  return (
    <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
  );
}

export function useConversations(): ConversationsContextValue {
  const ctx = useContext(ConversationsContext);
  if (!ctx) {
    throw new Error("useConversations must be used within a ConversationsProvider");
  }
  return ctx;
}
