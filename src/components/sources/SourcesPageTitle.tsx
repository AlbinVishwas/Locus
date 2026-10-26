"use client";

import AdminShell from "@/components/admin/AdminShell";
import { useFeatures } from "@/components/FeaturesProvider";
import SourcesView from "./SourcesView";

/** The administrator's "Sources", or an ordinary account's "My folders" (LOCUS_USER_SOURCES). */
export default function SourcesPageTitle() {
  const { isAdmin } = useFeatures();
  return (
    <AdminShell title={isAdmin ? "Sources" : "My folders"} access="sources">
      <SourcesView />
    </AdminShell>
  );
}
