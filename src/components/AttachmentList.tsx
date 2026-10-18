"use client";

import { useCyclingWord } from "@/lib/useCyclingWord";
import type { ConversationFile, UploadStageEvent } from "@/lib/uploadsClient";
import Loader from "./Loader";

export interface InProgressUpload {
  tempId: string;
  name: string;
  stage: UploadStageEvent;
}

interface AttachmentListProps {
  files: ConversationFile[];
  uploading: InProgressUpload[];
}

/** Attach/drag-drop lives in ChatInput; this is just the visible result: what's uploading right now, and what's already attached to this conversation. Nothing to render for either list is the common case, so the composer stays unchanged until a file shows up. */
export default function AttachmentList({ files, uploading }: AttachmentListProps) {
  if (files.length === 0 && uploading.length === 0) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-wrap gap-2 px-4 pb-2 sm:px-6">
      {uploading.map((u) => (
        <UploadingChip key={u.tempId} upload={u} />
      ))}
      {files.map((f) => (
        <FileChip key={f.id} file={f} />
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

function stageLabel(stage: UploadStageEvent, cycledWord: string): string {
  if (stage.type === "error") return stage.message;
  if (stage.type === "ready") return "Ready";
  if (stage.stage === "running-ocr") return `Running OCR, page ${stage.page} of ${stage.totalPages}`;
  return cycledWord;
}

function UploadingChip({ upload }: { upload: InProgressUpload }) {
  const { stage } = upload;
  const isError = stage.type === "error";
  // Always called, every render, regardless of which stage is active --
  // React hooks can't be called conditionally. For a non-cycling stage the
  // word list is a single space, so the hook still runs but stageLabel
  // below never uses its output.
  const words = cyclingWordsFor(stage);
  const cycledWord = useCyclingWord(words.length > 0 ? words : [" "]);

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] ${
        isError ? "border-line text-secondary" : "border-line bg-surface text-primary"
      }`}
    >
      {!isError && <Loader />}
      <span className="max-w-[160px] truncate" title={upload.name}>
        {upload.name}
      </span>
      <span className="text-secondary">{stageLabel(stage, cycledWord)}</span>
    </div>
  );
}

function FileChip({ file }: { file: ConversationFile }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-primary">
      <DocumentIcon />
      <span className="max-w-[160px] truncate" title={file.originalFilename}>
        {file.originalFilename}
      </span>
      <span className="text-secondary">{fileStatusLabel(file)}</span>
    </div>
  );
}

function fileStatusLabel(file: ConversationFile): string {
  if (file.status === "failed") return "Couldn't be read";
  if (file.status === "indexing") return "Finishing OCR…";
  return expiresLabel(file.expiresAt);
}

function expiresLabel(expiresAt: string): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Expires today";
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
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
