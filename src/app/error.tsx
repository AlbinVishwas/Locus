"use client";

import { useEffect } from "react";
import ErrorPage from "@/components/ErrorPage";

/** A problem inside one page: nothing technical is shown (the server log has the details), with a way to try again. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The digest ties this to the server log entry; the message itself is never shown.
    console.error("Locus page error", error.digest ?? "");
  }, [error]);
  return (
    <ErrorPage code="LOCUS-APP-001" reference={error.digest}>
      <button type="button" onClick={reset} className="cursor-pointer rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink">
        Try again
      </button>
      <a href="/" className="rounded-lg border border-line px-3.5 py-2 text-[13px] text-primary hover:bg-surface-hover">
        Back to search
      </a>
    </ErrorPage>
  );
}
