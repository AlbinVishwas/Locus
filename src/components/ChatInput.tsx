"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ChatInputProps {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

// ~8 lines at 15px / 1.7 line-height, plus the textarea's own padding.
const MAX_TEXTAREA_HEIGHT = 214;

export default function ChatInput({ isStreaming, onSend, onStop }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  // Coarse pointer (touch) means no Shift key to pair with Enter, so Enter
  // has to fall back to its native behavior (newline) instead of sending.
  // Checked via matchMedia, not UA sniffing, so it tracks actual input
  // capability — a touch laptop with a keyboard still counts as fine.
  const isCoarsePointerRef = useRef(false);

  useEffect(() => {
    const mql = window.matchMedia("(pointer: coarse)");
    const update = () => {
      isCoarsePointerRef.current = mql.matches;
    };
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Autofocus on mount, and refocus after every response finishes
  // streaming — matches ChatGPT's feel of always being ready for the
  // next message without an extra click.
  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset first so scrollHeight reflects content, not the previous height.
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const canSend = value.trim().length > 0 && !isStreaming;

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(value);
    setValue("");
  }, [canSend, onSend, value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !isComposingRef.current &&
      !isCoarsePointerRef.current
    ) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="px-4 pb-6 pt-2 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-3xl border border-line bg-surface px-4 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.35)]">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => (isComposingRef.current = true)}
            onCompositionEnd={() => (isComposingRef.current = false)}
            rows={1}
            placeholder="Message"
            className="max-h-[214px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-[1.7] text-primary outline-none placeholder:text-secondary"
          />
          <button
            type="button"
            onClick={isStreaming ? onStop : submit}
            disabled={!isStreaming && !canSend}
            aria-label={isStreaming ? "Stop generating" : "Send message"}
            className="mb-1 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-ink transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
          >
            {isStreaming ? <StopIcon /> : <SendIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}
