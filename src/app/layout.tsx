import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
import { ConversationsProvider } from "@/components/ConversationsProvider";
import { FeaturesProvider } from "@/components/FeaturesProvider";
import { isChatEnabled } from "@/config/features";
import { ensureRetentionScheduleStarted } from "@/lib/uploads/cleanup";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return {
    title: "Locus",
    description: isChatEnabled()
      ? "A local chat and document-search interface for LM Studio"
      : "Search inside your own documents, locally",
  };
}

// Rendered for every page -- including the plain healthcheck GET /
// `npm run share` makes to confirm the server is up -- so this is the
// earliest point retention cleanup can safely start without an
// instrumentation.ts hook (see the comment on ensureRetentionScheduleStarted
// in src/lib/uploads/cleanup.ts for why that hook isn't used). A no-op
// when uploads are disabled (e.g. on Vercel).
ensureRetentionScheduleStarted();

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Request time, not build time: LOCUS_CHAT_ENABLED is read when the
  // page is served, so flipping it takes a restart, never a rebuild.
  await connection();
  const features = { chatEnabled: isChatEnabled() };

  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">
        <FeaturesProvider features={features}>
          <ConversationsProvider>{children}</ConversationsProvider>
        </FeaturesProvider>
      </body>
    </html>
  );
}
