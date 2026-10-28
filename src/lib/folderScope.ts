"use client";

import { useSyncExternalStore } from "react";

/**
 * The folder the user picked on their own device, if a search is limited to
 * it. While one is set every search covers only that folder's files (its own
 * private upload session, `conversationId`) -- not other uploads, not other
 * folders, not the library. Kept for this browser tab (sessionStorage) so a
 * reload keeps the chip; blocked storage just means it lasts for this page.
 */
export interface FolderScope {
  name: string;
  files: number;
  conversationId: string;
}

const KEY = "locus.folderScope";
const listeners = new Set<() => void>();
let memory: FolderScope | null | undefined;
let raw = "";

function load(): FolderScope | null {
  if (memory !== undefined) return memory;
  try {
    const text = window.sessionStorage.getItem(KEY);
    const v = text ? (JSON.parse(text) as FolderScope) : null;
    memory = v && typeof v.conversationId === "string" && typeof v.name === "string" ? v : null;
  } catch {
    memory = null;
  }
  raw = JSON.stringify(memory);
  return memory;
}

export function getFolderScope(): FolderScope | null {
  return typeof window === "undefined" ? null : load();
}

export function setFolderScope(scope: FolderScope | null): void {
  memory = scope;
  raw = JSON.stringify(scope);
  try {
    if (scope) window.sessionStorage.setItem(KEY, raw);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

export function useFolderScope(): FolderScope | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getFolderScope,
    () => null
  );
}

// --- Reading a picked folder -------------------------------------------------

export interface PickedPdf {
  file: File;
  /** Path inside the picked folder, without the folder's own name: "Tenders/a.pdf". */
  path: string;
}

export interface Pick {
  /** The folder's own name. */
  name: string;
  pdfs: PickedPdf[];
  /** Files that aren't PDFs (anything else, including hidden files). */
  skipped: number;
}

const isPdf = (f: File) => f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf";

/** Sorts what <input webkitdirectory> returned into PDFs (kept) and everything else (skipped). */
export function readPick(list: FileList | File[]): Pick | null {
  const files = [...list];
  if (files.length === 0) return null;
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const name = rel(files[0]).split("/")[0] || "Folder";
  const pdfs: PickedPdf[] = [];
  let skipped = 0;
  for (const file of files) {
    if (isPdf(file) && !file.name.startsWith(".")) {
      // "Folder/sub/a.pdf" -> "sub/a.pdf"
      const parts = rel(file).split("/");
      pdfs.push({ file, path: (parts.length > 1 ? parts.slice(1) : parts).join("/") });
    } else skipped++;
  }
  pdfs.sort((a, b) => a.path.localeCompare(b.path));
  return { name, pdfs, skipped };
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FolderLimits {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes: number;
  /** How many files to send at once. */
  uploadParallel?: number;
}

export async function getFolderLimits(): Promise<FolderLimits> {
  const res = await fetch("/api/folders");
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return (await res.json()) as FolderLimits;
}

export interface FolderPlan {
  conversationId: string;
  total: number;
  present: number;
  removed: number;
  /** Paths still to upload. */
  upload: string[];
}

export async function planFolder(name: string, files: Array<{ path: string; size: number; sha256: string }>): Promise<FolderPlan> {
  const res = await fetch("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, files }) });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
  return (await res.json()) as FolderPlan;
}
