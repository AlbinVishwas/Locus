import type { Metadata } from "next";
import "./globals.css";
import { ConversationsProvider } from "@/components/ConversationsProvider";
import { ensureRetentionScheduleStarted } from "@/lib/uploads/cleanup";

export const metadata: Metadata = {
  title: "Locus",
  description: "A local chat and document-search interface for LM Studio",
};

// Rendered for every page -- including the plain healthcheck GET /
// `npm run share` makes to confirm the server is up -- so this is the
// earliest point retention cleanup can safely start without an
// instrumentation.ts hook (see the comment on ensureRetentionScheduleStarted
// in src/lib/uploads/cleanup.ts for why that hook isn't used). A no-op
// when uploads are disabled (e.g. on Vercel).
ensureRetentionScheduleStarted();

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">
        <ConversationsProvider>{children}</ConversationsProvider>
      </body>
    </html>
  );
}
