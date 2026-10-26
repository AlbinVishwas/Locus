import type { Metadata } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import "./globals.css";
import { ConversationsProvider } from "@/components/ConversationsProvider";
import { FeaturesProvider, type ClientFeatures } from "@/components/FeaturesProvider";
import { isChatEnabled } from "@/config/features";
import { SESSION_COOKIE } from "@/lib/auth";
import { userFromToken } from "@/lib/session";
import { adminEnabled, userSourcesEnabled, usersEnabled } from "@/lib/users/mode";
import { isLibraryEnabled, searchScope, type SearchScope } from "@/lib/library/config";
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

function defaultScope(): SearchScope {
  try {
    return searchScope();
  } catch (err) {
    console.error(`[library] ${err instanceof Error ? err.message : err}; using "session"`);
    return "session";
  }
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Request time, not build time: LOCUS_CHAT_ENABLED is read when the
  // page is served, so flipping it takes a restart, never a rebuild.
  await connection();
  const users = usersEnabled();
  const user = users ? await userFromToken((await cookies()).get(SESSION_COOKIE)?.value) : null;
  const isAdmin = user?.role === "admin" && adminEnabled();
  // The library is the administrator's: with named accounts, everyone else gets the plain
  // "search your own uploads" app -- unless they may add their own folders (LOCUS_USER_SOURCES).
  const userSources = users && userSourcesEnabled() && user !== null && !isAdmin;
  const libraryEnabled = isLibraryEnabled() && (!users || isAdmin || userSources);
  // Only computed (and only sent) with the library on: with it off, the
  // browser gets exactly what it always did.
  const features: ClientFeatures = libraryEnabled
    ? { chatEnabled: isChatEnabled(), libraryEnabled, defaultScope: defaultScope() }
    : { chatEnabled: isChatEnabled() };
  if (users) {
    features.usersEnabled = true;
    if (user) {
      features.userId = user.id;
      features.username = user.username;
      features.isAdmin = isAdmin;
      if (userSources && libraryEnabled) features.userSources = true;
    }
  }

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
