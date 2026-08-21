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
import type { Conversation, DisplayMessage } from "@/lib/types";

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
  | { type: "updateMessages"; id: string; messages: DisplayMessage[] };

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
      const conversations = state.conversations.map((c) =>
        c.id === action.id ? { ...c, title: action.title, updatedAt: Date.now() } : c
      );
      return { ...state, conversations };
    }

    case "updateMessages": {
      const conversations = state.conversations.map((c) => {
        if (c.id !== action.id) return c;
        // Auto-title fires once, from the first user message, and never
        // again — an existing title is never overwritten.
        const title = c.title || deriveTitle(action.messages);
        return { ...c, messages: action.messages, title, updatedAt: Date.now() };
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

  // Read localStorage only after mount, never during render. The first
  // render (server + first client hydration pass) always shows the empty
  // initialState above, so there's nothing for hydration to mismatch —
  // real data arrives one tick later via a normal client-side update.
  useEffect(() => {
    dispatch({ type: "hydrate", conversations: loadConversations() });
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
  const deleteConversation = useCallback((id: string) => dispatch({ type: "delete", id }), []);
  const renameConversation = useCallback(
    (id: string, title: string) => dispatch({ type: "rename", id, title }),
    []
  );

  const activeConversationIdRef = useRef(state.activeConversationId);
  useEffect(() => {
    activeConversationIdRef.current = state.activeConversationId;
  }, [state.activeConversationId]);
  const updateActiveMessages = useCallback((messages: DisplayMessage[]) => {
    const id = activeConversationIdRef.current;
    if (!id) return;
    dispatch({ type: "updateMessages", id, messages });
  }, []);

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
