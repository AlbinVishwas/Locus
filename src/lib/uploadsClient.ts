/**
 * Browser-side calls to /api/uploads. Deliberately separate from
 * src/lib/uploads/ (server-only: fs, better-sqlite3, child processes) so
 * nothing there can end up in a client bundle by accident.
 */

export interface ConversationFile {
  id: number;
  originalFilename: string;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  status: "ready" | "indexing" | "failed";
  uploadedAt: string;
  expiresAt: string;
  error: string | null;
}

export type UploadStageEvent =
  | { type: "stage"; stage: "uploading" | "reading" | "indexing" }
  | { type: "stage"; stage: "running-ocr"; page: number; totalPages: number }
  | { type: "ready"; docId: number; pageCount: number }
  | { type: "error"; message: string };

export interface StorageInfo {
  usedBytes: number;
  capBytes: number;
}

export async function getStorageInfo(): Promise<StorageInfo | null> {
  const res = await fetch("/api/storage");
  if (!res.ok) return null;
  return (await res.json()) as StorageInfo;
}

export async function listConversationFiles(conversationId: string): Promise<ConversationFile[]> {
  const res = await fetch(`/api/uploads?conversationId=${encodeURIComponent(conversationId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { documents: ConversationFile[] };
  return body.documents;
}

export async function deleteConversationFiles(conversationId: string): Promise<void> {
  await fetch(`/api/uploads?conversationId=${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  }).catch(() => {}); // best-effort: a conversation being deleted locally shouldn't block on the network
}

/**
 * Uploads one file, calling `onEvent` as its SSE progress events arrive.
 * Resolves once the stream ends (ready, or error, or the connection just
 * closes) rather than throwing — the caller reads the last event it saw
 * to know which happened.
 */
export async function uploadFile(
  conversationId: string,
  file: File,
  onEvent: (event: UploadStageEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const form = new FormData();
  form.set("conversationId", conversationId);
  form.set("file", file);

  const res = await fetch("/api/uploads", { method: "POST", body: form, signal });
  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: await res.text().catch(() => res.statusText) });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        onEvent(JSON.parse(dataLine.slice("data: ".length)) as UploadStageEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
