"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationFile } from "@/lib/uploadsClient";
import AttachmentList, { type InProgressUpload } from "./AttachmentList";

interface ChatInputProps {
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  files: ConversationFile[];
  uploading: InProgressUpload[];
  onAttachFiles: (files: File[]) => void;
}

// ~8 lines at 15px / 1.7 line-height, plus the textarea's own padding.
const MAX_TEXTAREA_HEIGHT = 214;

export default function ChatInput({
  isStreaming,
  onSend,
  onStop,
  files,
  uploading,
  onAttachFiles,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onAttachFiles([...list].filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")));
  };

  return (
    <div
      className="px-4 pb-6 pt-2 sm:px-6"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-3xl">
        <AttachmentList files={files} uploading={uploading} />
        <div
          className={`flex items-end gap-2 rounded-3xl border bg-surface px-4 py-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.35)] ${
            isDragOver ? "border-secondary" : "border-line"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach a PDF"
            title="Attach a PDF"
            className="mb-1 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-secondary hover:bg-surface-hover hover:text-primary"
          >
            <AttachIcon />
          </button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => (isComposingRef.current = true)}
            onCompositionEnd={() => (isComposingRef.current = false)}
            rows={1}
            placeholder={isDragOver ? "Drop a PDF to attach it" : "Message"}
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

function AttachIcon() {
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
      <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L9.47 17.36a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
    </svg>
  );
}
