// src/app/documents/page.tsx
import { getDocumentsForCurrentUser, requireSession } from "@/lib/dal";
import { listDocuments } from "@/lib/db";

export default async function DocumentsPage() {
  // The proxy already bounced anonymous traffic, but it only inspected a token.
  // This is the check that survives a deleted account or a stale matcher.
  const session = await requireSession();
  const visible = await getDocumentsForCurrentUser();
  const visibleIds = new Set(visible.map((doc) => doc.id));
  const locked = (await listDocuments()).filter((doc) => !visibleIds.has(doc.id));

  return (
    <main>
      <h1>Documents</h1>
      <p>
        Signed in as {session.email} ({session.role}).
      </p>

      <ul>
        {visible.map((doc) => (
          <li key={doc.id}>
            {/* A plain anchor, so the 204/302 behaviour of the download route is
                exercised by a real browser download rather than by fetch(). */}
            <a download href={`/documents/${doc.id}/download`}>
              {doc.title}
            </a>{" "}
            <small>requires {doc.requiredRole}</small>
          </li>
        ))}
      </ul>

      {locked.length > 0 ? (
        <>
          <h2>Not available to your role</h2>
          <ul>
            {locked.map((doc) => (
              <li key={doc.id}>
                {doc.title} <small>requires {doc.requiredRole}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
