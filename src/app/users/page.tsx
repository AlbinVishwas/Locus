import AdminShell from "@/components/admin/AdminShell";
import UsersView from "@/components/admin/UsersView";

export default function UsersPage() {
  return (
    <AdminShell title="Users">
      <UsersView />
    </AdminShell>
  );
}
