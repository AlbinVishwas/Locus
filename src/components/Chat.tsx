"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSSEStream } from "@/lib/parseSSE";
import { createId } from "@/lib/id";
import { toHistoryPayload } from "@/lib/history";
import type { Conversation, DisplayMessage } from "@/lib/types";
import {
  listConversationFiles,
  uploadFile,
  type ConversationFile,
} from "@/lib/uploadsClient";
import type { InProgressUpload } from "./AttachmentList";
import MessageList from "./MessageList";
import ChatInput from "./ChatInput";

const SCROLL_BOTTOM_THRESHOLD_PX = 80;

interface ChatProps {
  conversation: Conversation;
  onMessagesChange: (messages: DisplayMessage[]) => void;
}

/**
 * Renders one conversation. The parent is expected to remount this
 * component (via `key={conversation.id}`) whenever the active conversation
 * changes — that's what makes the "abort in-flight request before
 * switching" guard trivial: React tears down the old instance (running its
 * unmount cleanup, which aborts) before the new instance for the new
 * conversation ever mounts. `conversation` is only read for its initial
 * message list; `onMessagesChange` is the sole way changes flow back out —
 * this component does not own the conversation list itself.
 */
export default function Chat({ conversation, onMessagesChange }: ChatProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>(conversation.messages);
  const [isStreaming, setIsStreaming] = useState(false);
  // Transient read-phase state for the in-flight turn only. Deliberately not
  // on DisplayMessage: that gets persisted, and this describes a moment
  // rather than the message.
  const [fetchingUrls, setFetchingUrls] = useState<string[] | null>(null);

  // This conversation's uploaded files (server-confirmed) and whatever's
  // still being uploaded/indexed right now. Neither is persisted locally —
  // files are refetched from the index on mount, and uploading is purely
  // in-flight state — so there's nothing here for toHistoryPayload to
  // worry about.
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [uploading, setUploading] = useState<InProgressUpload[]>([]);

  const refreshFiles = useCallback(() => {
    listConversationFiles(conversation.id).then(setFiles);
  }, [conversation.id]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const handleAttachFiles = useCallback(
    (toUpload: File[]) => {
      for (const file of toUpload) {
        const tempId = createId();
        setUploading((prev) => [
          ...prev,
          { tempId, name: file.name, stage: { type: "stage", stage: "uploading" } },
        ]);

        uploadFile(conversation.id, file, (event) => {
          setUploading((prev) => prev.map((u) => (u.tempId === tempId ? { ...u, stage: event } : u)));
          if (event.type === "ready") {
            refreshFiles();
            setUploading((prev) => prev.filter((u) => u.tempId !== tempId));
          }
          // An error stays visible in the chip (stageLabel shows its
          // message) rather than disappearing silently; the next attach
          // or a conversation switch is what clears it.
        }).catch(() => {
          setUploading((prev) =>
            prev.map((u) =>
              u.tempId === tempId
                ? { ...u, stage: { type: "error", message: "Upload failed" } }
                : u
            )
          );
        });
      }
    },
    [conversation.id, refreshFiles]
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Mirrors `messages`, updated synchronously (not via effect) so
  // commitMessages always has an up-to-date value to patch from without
  // going through React's functional-updater form — see commitMessages.
  const messagesRef = useRef<DisplayMessage[]>(conversation.messages);

  // Read via a ref so commitMessages below never needs onMessagesChange in
  // its own dependency array — callers don't have to memoize the callback.
  const onMessagesChangeRef = useRef(onMessagesChange);
  useEffect(() => {
    onMessagesChangeRef.current = onMessagesChange;
  }, [onMessagesChange]);

  // Guarantees the in-flight request is cancelled before this conversation
  // is ever left (unmount = the parent switched `key`, i.e. switched
  // conversations, or the page itself unmounted).
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Auto-scroll to bottom whenever messages change, unless the user has
  // scrolled up to read earlier content — that intent should stick until
  // they scroll back down themselves.
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  // Every message mutation goes through here: it updates local state (for
  // this component's own render loop) and pushes the same result up to the
  // conversation owner in the same tick. The owner decides what to do with
  // it — including how often that turns into a localStorage write.
  //
  // Deliberately NOT `setMessages((prev) => { ...; onMessagesChangeRef...(); return next })`:
  // React treats functional updaters as pure and may invoke them outside a
  // normal event-handler context (e.g. Strict Mode re-invokes them to
  // surface exactly this kind of bug), so calling another component's
  // setState from inside one throws "Cannot update a component while
  // rendering a different component." Reading/writing messagesRef instead
  // of `prev` keeps the updater's side effect (notifying the parent)
  // outside of React's state-update machinery entirely.
  const commitMessages = useCallback(
    (updater: (prev: DisplayMessage[]) => DisplayMessage[]) => {
      const next = updater(messagesRef.current);
      messagesRef.current = next;
      setMessages(next);
      onMessagesChangeRef.current(next);
    },
    []
  );

  const patchAssistantMessage = useCallback(
    (id: string, updater: (m: DisplayMessage) => DisplayMessage) => {
      commitMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    },
    [commitMessages]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      shouldAutoScrollRef.current = true;

      const userMessage: DisplayMessage = {
        id: createId(),
        role: "user",
        content: trimmed,
        reasoning: "",
        reasoningMs: null,
        isStreaming: false,
      };
      const assistantId = createId();
      const assistantMessage: DisplayMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        reasoning: "",
        reasoningMs: null,
        isStreaming: true,
        failure: null,
      };

      const historyPayload = toHistoryPayload([...messages, userMessage]);

      commitMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let reasoningStartedAt: number | null = null;
      let reasoningEndedAt: number | null = null;
      let hasVisibleOutput = false;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: historyPayload, conversationId: conversation.id }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(
            `Request failed (${res.status}): ${await res.text().catch(() => res.statusText)}`
          );
        }

        for await (const event of parseSSEStream(res.body)) {
          // Any token means generation has started, so the read phase is
          // over — clear it before handling the token itself.
          if (event.type === "reasoning" || event.type === "content") {
            setFetchingUrls(null);
          }

          if (event.type === "fetching") {
            setFetchingUrls(event.urls);
          } else if (event.type === "searchResult") {
            // Counts as visible output on its own: a search card the user
            // can act on is a complete, useful turn even if the model
            // itself fails right after (LM Studio down, say) -- it must
            // survive the "nothing came back, drop this turn" check below.
            hasVisibleOutput = true;
            patchAssistantMessage(assistantId, (m) => ({
              ...m,
              searchResult: event.result,
              looseAlternative: event.looseAlternative,
            }));
          } else if (event.type === "reasoning") {
            hasVisibleOutput = true;
            if (reasoningStartedAt === null) reasoningStartedAt = performance.now();
            patchAssistantMessage(assistantId, (m) => ({
              ...m,
              reasoning: m.reasoning + event.text,
            }));
          } else if (event.type === "content") {
            hasVisibleOutput = true;
            // First content token marks the end of the reasoning phase —
            // that's the "Thought for Ns" duration shown once collapsed.
            if (reasoningStartedAt !== null && reasoningEndedAt === null) {
              reasoningEndedAt = performance.now();
              const elapsed = reasoningEndedAt - reasoningStartedAt;
              patchAssistantMessage(assistantId, (m) => ({
                ...m,
                content: m.content + event.text,
                reasoningMs: elapsed,
              }));
            } else {
              patchAssistantMessage(assistantId, (m) => ({
                ...m,
                content: m.content + event.text,
              }));
            }
          } else if (event.type === "error") {
            hasVisibleOutput = true;
            patchAssistantMessage(assistantId, (m) => ({
              ...m,
              failure: event.message,
            }));
          }
        }

        // Reasoning-only edge case: the model streamed reasoning_content
        // but the connection ended before any content token arrived to
        // stamp a duration. Finalize it now so "Thinking" isn't stuck open.
        if (reasoningStartedAt !== null && reasoningEndedAt === null) {
          const elapsed = performance.now() - reasoningStartedAt;
          patchAssistantMessage(assistantId, (m) => ({
            ...m,
            reasoningMs: elapsed,
          }));
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (!isAbort) {
          hasVisibleOutput = true;
          patchAssistantMessage(assistantId, (m) => ({
            ...m,
            failure: err instanceof Error ? err.message : "Something went wrong.",
          }));
        }
      } finally {
        // Covers the paths that never reach a token: abort, network error, or
        // a stream that ends after "fetching" without generating.
        setFetchingUrls(null);
        if (hasVisibleOutput) {
          patchAssistantMessage(assistantId, (m) => ({ ...m, isStreaming: false }));
        } else {
          commitMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages, isStreaming, commitMessages, patchAssistantMessage, conversation.id]
  );

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-page text-primary">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <MessageList
          messages={messages}
          fetchingUrls={fetchingUrls}
        />
      </div>
      <ChatInput
        isStreaming={isStreaming}
        onSend={sendMessage}
        onStop={stopGeneration}
        files={files}
        uploading={uploading}
        onAttachFiles={handleAttachFiles}
      />
    </div>
  );
}
