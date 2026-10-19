"use client";

import { useState } from "react";
import { useCyclingWord } from "@/lib/useCyclingWord";
import type { ConversationFile, UploadStageEvent } from "@/lib/uploadsClient";
import StageLine from "./StageLine";

export interface InProgressUpload {
  tempId: string;
  name: string;
  stage: UploadStageEvent;
}

interface AttachmentListProps {
  files: ConversationFile[];
  uploading: InProgressUpload[];
  /** The per-file remove button, after the user confirms. */
  onRemoveFile: (docId: number) => void;
}

/** Attach/drag-drop lives in ChatInput; this is just the visible result: what's uploading right now, and what's already attached to this conversation. Nothing to render for either list is the common case, so the composer stays unchanged until a file shows up. */
export default function AttachmentList({ files, uploading, onRemoveFile }: AttachmentListProps) {
  if (files.length === 0 && uploading.length === 0) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-wrap gap-2 px-4 pb-2 sm:px-6">
      {uploading.map((u) => (
        <UploadingChip key={u.tempId} upload={u} />
      ))}
      {files.map((f) => (
        <FileChip key={f.id} file={f} onRemove={() => onRemoveFile(f.id)} />
      ))}
    </div>
  );
}

/**
 * A few cycling words for a stage with no finer detail to show -- cosmetic
 * variety for something that actually is happening, never for a stage
 * that isn't. A stage with a real number to report (OCR's "page N of M")
 * isn't in here: that counter is the real progress, not flavor text.
 */
function cyclingWordsFor(stage: UploadStageEvent): string[] {
  if (stage.type !== "stage") return [];
  switch (stage.stage) {
    case "uploading":
      return ["Uploading", "Sending", "Transferring"];
    case "reading":
      return ["Reading", "Scanning", "Skimming"];
    case "indexing":
      return ["Indexing", "Filing", "Cataloguing"];
    case "running-ocr":
      return [];
  }
}

function UploadingChip({ upload }: { upload: InProgressUpload }) {
  const { stage, name } = upload;
  const isError = stage.type === "error";
  const isOcr = stage.type === "stage" && stage.stage === "running-ocr";
  // Always called, every render, regardless of which stage is active --
  // React hooks can't be called conditionally. For a non-cycling stage the
  // word list is a single space, so the hook still runs but the label
  // below never uses its output.
  const words = cyclingWordsFor(stage);
  const cycledWord = useCyclingWord(words.length > 0 ? words : [" "]);

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-secondary">
        <span className="max-w-[160px] truncate" title={name}>
          {name}
        </span>
        <span>{stage.message}</span>
      </div>
    );
  }

  if (stage.type === "ready") {
    // A beat between the server saying "ready" and the parent re-fetching
    // the confirmed file list and dropping this chip -- shown as finished,
    // not as a dangling "Ready" word with no stage line of its own.
    return (
      <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">
        <StageLine state="finished" label={name} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">
      <StageLine
        state="active"
        label={isOcr ? `Scanning page ${stage.page} of ${stage.totalPages}` : `${cycledWord} ${name}`}
      />
      {isOcr && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-line" aria-hidden>
          <div
            className="h-full rounded-full bg-cream transition-[width] duration-300"
            style={{ width: `${Math.round((stage.page / Math.max(1, stage.totalPages)) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function FileChip({ file, onRemove }: { file: ConversationFile; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);

  // Confirming replaces the chip's whole content, the same inline pattern
  // ConversationItem uses for "delete this chat?" -- no modal, per the
  // design brief, and it's the one thing in the chip that still needs a
  // second thought: everything else here is just status.
  if (confirming) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]"
        onKeyDown={(e) => {
          if (e.key === "Escape") setConfirming(false);
        }}
      >
        <span className="max-w-[140px] truncate text-secondary">Remove {file.originalFilename}?</span>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-primary hover:bg-surface-hover"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-secondary hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (file.status === "failed") {
    return (
      <ChipShell onRemove={() => setConfirming(true)}>
        <DocumentIcon />
        <span className="max-w-[160px] truncate text-secondary" title={file.originalFilename}>
          {file.originalFilename}
        </span>
        <span className="text-secondary">Couldn&apos;t be read</span>
      </ChipShell>
    );
  }

  if (file.status === "indexing") {
    return (
      <ChipShell onRemove={() => setConfirming(true)} bordered>
        <StageLine state="active" label={`Finishing OCR: ${file.originalFilename}`} />
      </ChipShell>
    );
  }

  return (
    <ChipShell onRemove={() => setConfirming(true)}>
      <DocumentIcon />
      <span className="max-w-[160px] truncate text-primary" title={file.originalFilename}>
        {file.originalFilename}
      </span>
      <span className="text-secondary">
        {file.pageCount} {file.pageCount === 1 ? "page" : "pages"}
      </span>
    </ChipShell>
  );
}

/** The shared chip frame + remove (×) button every file state (besides the confirm prompt) renders inside. */
function ChipShell({
  children,
  onRemove,
  bordered = false,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  bordered?: boolean;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px] ${
        bordered ? "bg-surface" : ""
      }`}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove file"
        title="Remove file"
        className="shrink-0 cursor-pointer rounded p-0.5 text-secondary opacity-60 hover:bg-surface-hover hover:text-primary hover:opacity-100"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-secondary"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
