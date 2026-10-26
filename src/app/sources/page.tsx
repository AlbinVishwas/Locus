import AdminShell from "@/components/admin/AdminShell";
import SourcesView from "@/components/sources/SourcesView";

export default function SourcesPage() {
  return (
    <AdminShell title="Sources">
      <SourcesView />
    </AdminShell>
  );
}
