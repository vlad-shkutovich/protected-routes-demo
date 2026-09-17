// src/app/documents/page.tsx
import { requestAccess } from "@/app/documents/actions";
import { getDocumentsForCurrentUser, requireSession } from "@/lib/dal";

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ requested?: string }>;
}) {
  // The proxy already bounced anonymous traffic, but it only inspected a token.
  // This is the check that survives a deleted account or a stale matcher.
  const session = await requireSession();

  // Only what this user may see. Listing the titles of the others would leak the
  // very thing the role check exists to hide.
  const documents = await getDocumentsForCurrentUser();
  const { requested } = await searchParams;

  return (
    <main>
      <h1>Documents</h1>
      <p>
        Signed in as {session.email} ({session.role}).
      </p>
      {requested ? <p role="status">Access request recorded: {requested}</p> : null}

      <ul>
        {documents.map((doc) => (
          <li key={doc.id}>
            {/* A plain anchor, so the 204 refusal of the download route is exercised
                by a real browser download rather than by fetch(). */}
            <a download href={`/documents/${doc.id}/download`}>
              {doc.title}
            </a>{" "}
            <small>requires {doc.requiredRole}</small>{" "}
            <form action={requestAccess}>
              <input name="documentId" type="hidden" value={doc.id} />
              <button type="submit">Request a fresh copy</button>
            </form>
          </li>
        ))}
      </ul>

      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
