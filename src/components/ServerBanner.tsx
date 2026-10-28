"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeaturesProvider";
import { getServerStatus, type ServerStatus } from "@/lib/serverClient";

/**
 * A slim notice at the top of search for the administrator when the storage server, the disk or the indexer has a
 * problem. Search over what is already indexed is never blocked by it: this only tells you why new files may be
 * missing. Hidden when all is well, and for everyone who isn't the administrator.
 */
export default function ServerBanner() {
  const { isAdmin, libraryEnabled } = useFeatures();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    if (!isAdmin || !libraryEnabled) return;
    let live = true;
    const load = () =>
      getServerStatus()
        .then((r) => live && setStatus(r.ok ? r.data : null))
        .catch(() => live && setStatus(null));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [isAdmin, libraryEnabled]);
  const b = status?.banner;
  if (!b || b.tone === "info") return null;
  return (
    <div role="alert" className="border-b border-line bg-surface px-4 py-2 text-[13px] text-secondary">
      <span className="font-medium text-primary">{b.title}.</span> {b.message}{" "}
      <Link href="/server" className="text-primary underline underline-offset-2">
        Details
      </Link>
    </div>
  );
}
