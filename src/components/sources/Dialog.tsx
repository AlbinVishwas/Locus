"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal layer: dimmed page behind, focus kept inside, Escape asks to close,
 * focus returns to whatever opened it. At phone width it becomes a full-height
 * sheet. `initialFocus` picks the control to land on (a destructive dialog
 * lands on Cancel).
 */
export default function Dialog({
  title,
  onClose,
  children,
  role = "dialog",
  wide = false,
  initialFocus,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  role?: "dialog" | "alertdialog";
  wide?: boolean;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const target = (initialFocus ? node.querySelector<HTMLElement>(initialFocus) : null) ?? node.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog reacts: a second layer on top has its own handler.
      const layers = document.querySelectorAll("[data-dialog-layer]");
      if (layers[layers.length - 1] !== node.parentElement) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") {
        const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!node.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-dialog-layer className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={title}
        className={`flex h-dvh w-full flex-col overflow-hidden border-line bg-surface sm:h-auto sm:max-h-[90dvh] sm:rounded-xl sm:border ${wide ? "sm:max-w-[560px]" : "sm:max-w-[420px]"}`}
      >
        {children}
      </div>
    </div>
  );
}
