"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFeatures } from "@/components/FeaturesProvider";

const TABS = [
  { href: "/server", label: "Server", needsLibrary: true },
  { href: "/sources", label: "Sources", needsLibrary: true },
  { href: "/users", label: "Users" },
  { href: "/activity", label: "Activity" },
] as const;

/** The frame the admin pages share: a way back, the three admin areas, and a plain "not found" for anyone else. */
export default function AdminShell({ title, children, access = "admin" }: { title: string; children: React.ReactNode; access?: "admin" | "sources" }) {
  const { isAdmin, libraryEnabled, userSources } = useFeatures();
  const pathname = usePathname();
  // The Sources page is also for ordinary accounts when they may add their own folders; Users and Activity never are.
  if (!isAdmin && !(access === "sources" && userSources)) {
    return (
      <div className="flex h-dvh items-center justify-center bg-page px-4 text-[13px] text-secondary">Not found</div>
    );
  }
  return (
    <div className="min-h-dvh bg-page">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[1040px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-6">
          <Link href="/" className="text-[13px] text-secondary hover:text-primary">
            ← Back to search
          </Link>
          {isAdmin && (
          <nav aria-label="Admin" className="flex gap-1">
            {TABS.filter((t) => !("needsLibrary" in t) || libraryEnabled).map((t) => (
              <Link
                key={t.href}
                href={t.href}
                aria-current={pathname === t.href ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1.5 text-[13px] ${
                  pathname === t.href ? "bg-surface text-primary" : "text-secondary hover:bg-surface-hover"
                }`}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-6 md:px-6">
        <h1 className="mb-5 text-[17px] font-medium text-primary">{title}</h1>
        {children}
      </main>
    </div>
  );
}
