// src/app/admin/page.tsx
import { requireRole } from "@/lib/dal";

export default async function AdminPage() {
  // Non-admins are redirected to /documents by the DAL. The proxy cannot make this
  // call: the authoritative role lives in the database, not in the token claim.
  const session = await requireRole("admin");

  return (
    <main>
      <h1>Admin</h1>
      <p>
        {session.email} has the {session.role} role.
      </p>
    </main>
  );
}
