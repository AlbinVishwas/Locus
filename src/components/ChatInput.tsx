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
  onRemoveFile: (docId: number) => void;
  /**
   * "centered" is the empty-state composer (max-width 720px, with the
   * chip row below it); "pinned" is the normal bottom-of-conversation bar.
   * Same component either way -- send, attach, drag-drop, resize all
   * behave identically; only the layout and the chip row differ.
   */
  variant?: "pinned" | "centered";
}

// ~8 lines at 15px / 1.7 line-height, plus the textarea's own padding.
const MAX_TEXTAREA_HEIGHT = 214;

const DEFAULT_PLACEHOLDER = "Ask anything, or drop PDFs to search inside them";
const LINK_PLACEHOLDER = "Paste a link…";

export default function ChatInput({
  isStreaming,
  onSend,
  onStop,
  files,
  uploading,
  onAttachFiles,
  onRemoveFile,
  variant = "pinned",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  // Cosmetic only: "Read a link" swaps the placeholder to hint at what to
  // paste, until the user types something or looks away. It never changes
  // how a link already in `value` is treated -- urlContext.ts picks any
  // URL out of the message text regardless of what the placeholder said.
  const [linkMode, setLinkMode] = useState(false);
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
    setLinkMode(false);
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

  // Puts an empty quoted pair in the composer with the cursor between the
  // quotes, ready to type the exact phrase to search for -- quoting a
  // phrase is already how documentSearch.ts's extractQuotedText picks out
  // a precise search over the whole-message fallback.
  const insertQuotePair = () => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}""${value.slice(end)}`;
    setValue(next);
    el?.focus();
    requestAnimationFrame(() => el?.setSelectionRange(start + 1, start + 1));
  };

  const focusForLink = () => {
    setLinkMode(true);
    textareaRef.current?.focus();
  };

  const composerBar = (
    <div
      className={`flex items-end gap-2 rounded-[20px] border bg-composer px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${
        isDragOver ? "border-secondary" : "border-composer-line"
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
        onChange={(e) => {
          setValue(e.target.value);
          if (linkMode) setLinkMode(false);
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => (isComposingRef.current = true)}
        onCompositionEnd={() => (isComposingRef.current = false)}
        onBlur={() => setLinkMode(false)}
        rows={1}
        aria-label="Message"
        placeholder={
          isDragOver ? "Drop a PDF to attach it" : linkMode ? LINK_PLACEHOLDER : DEFAULT_PLACEHOLDER
        }
        className="max-h-[214px] flex-1 resize-none bg-transparent py-1.5 font-text text-[15px] leading-[1.7] text-primary outline-none placeholder:text-secondary"
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
  );

  const chipRow = (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
      <ChipButton onClick={() => fileInputRef.current?.click()} icon={<AttachIcon small />}>
        Upload documents
      </ChipButton>
      <ChipButton onClick={insertQuotePair} icon={<QuoteIcon />}>
        Find a phrase in files
      </ChipButton>
      <ChipButton onClick={focusForLink} icon={<LinkIcon />}>
        Read a link
      </ChipButton>
    </div>
  );

  const dragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
    },
    onDragLeave: () => setIsDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
  };

  if (variant === "centered") {
    return (
      <div className="w-full px-4" {...dragHandlers}>
        <div className="mx-auto max-w-[720px]">
          <AttachmentList files={files} uploading={uploading} onRemoveFile={onRemoveFile} />
          {composerBar}
          {chipRow}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-6 pt-2 sm:px-6" {...dragHandlers}>
      <div className="mx-auto max-w-[760px]">
        <AttachmentList files={files} uploading={uploading} onRemoveFile={onRemoveFile} />
        {composerBar}
      </div>
    </div>
  );
}

function ChipButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-secondary hover:border-composer-line hover:text-primary"
    >
      {icon}
      {children}
    </button>
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

function AttachIcon({ small = false }: { small?: boolean }) {
  const size = small ? 13 : 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L9.47 17.36a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 7h3v6H7a3 3 0 0 1-3-3 3 3 0 0 1 3-3Z" />
      <path d="M17 7h3v6h-3a3 3 0 0 1-3-3 3 3 0 0 1 3-3Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.5 5.41" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-2.12 2.12a5 5 0 0 0 7.07 7.07l1.49-1.49" />
    </svg>
  );
}
