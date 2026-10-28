import AdminShell from "@/components/admin/AdminShell";
import ServerView from "@/components/admin/ServerView";

export default function ServerPage() {
  return (
    <AdminShell title="Server">
      <ServerView />
    </AdminShell>
  );
}
