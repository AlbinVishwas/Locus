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
  /** Null unless LOCUS_RETENTION_DAYS is set -- files don't expire by default. */
  expiresAt: string | null;
  error: string | null;
}

export type UploadStageEvent =
  | { type: "stage"; stage: "uploading" | "reading" | "indexing" }
  | { type: "stage"; stage: "running-ocr"; page: number; totalPages: number }
  /** The file's text is searchable now; OCR of `ocrPages` more pages carries on, and a "ready" follows when it's done. */
  | { type: "searchable"; docId: number; pageCount: number; ocrPages: number }
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

/** The per-file remove button: deletes one uploaded document from a conversation. Returns whether it actually removed something, so the caller can tell a real failure from "already gone". */
export async function deleteConversationFile(conversationId: string, docId: number): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/uploads?conversationId=${encodeURIComponent(conversationId)}&docId=${docId}`,
      { method: "DELETE" }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** A failure worth trying again: the connection dropped, or a proxy or tunnel in front of the server gave up. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uploads one file, calling `onEvent` as its SSE progress events arrive.
 * Resolves once the stream ends (ready, or error, or the connection just
 * closes) rather than throwing — the caller reads the last event it saw
 * to know which happened.
 *
 * `retries` is how many more times to send the file when the connection fails
 * before an answer, or drops before the file is searchable, or a proxy answers
 * with a temporary error. Only a picked folder's files ask for it: the server
 * recognises a file it already has by path and content, so sending it twice
 * can't add it twice.
 */
export async function uploadFile(
  conversationId: string,
  file: File,
  onEvent: (event: UploadStageEvent) => void,
  signal?: AbortSignal,
  /** A picked folder's file: its path inside the folder, shown with its results. */
  path?: string,
  retries = 0
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("file", file);
    if (path) form.set("path", path);

    let res: Response;
    try {
      res = await fetch("/api/uploads", { method: "POST", body: form, signal });
    } catch (err) {
      if (signal?.aborted || attempt >= retries) throw err;
      await sleep(Math.min(8000, 800 * 2 ** attempt));
      continue;
    }
    if (!res.ok || !res.body) {
      if (attempt < retries && isTransientStatus(res.status)) {
        await sleep(Math.min(8000, 800 * 2 ** attempt));
        continue;
      }
      onEvent({ type: "error", message: await res.text().catch(() => res.statusText) });
      return;
    }

    let answered = false;
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
          const event = JSON.parse(dataLine.slice("data: ".length)) as UploadStageEvent;
          if (event.type === "ready" || event.type === "error" || event.type === "searchable") answered = true;
          onEvent(event);
        }
      }
    } catch (err) {
      if (signal?.aborted || attempt >= retries) throw err;
    } finally {
      reader.releaseLock();
    }
    // The stream ended with no answer: the connection dropped. Send it again if we may.
    if (answered || attempt >= retries) return;
    await sleep(Math.min(8000, 800 * 2 ** attempt));
  }
}
