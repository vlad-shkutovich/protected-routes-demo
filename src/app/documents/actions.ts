// src/app/documents/actions.ts
"use server";

import { redirect } from "next/navigation";

import { getDocumentForCurrentUser, requireSession } from "@/lib/dal";

/** Ids are opaque slugs; anything else never reaches the store. */
const DOCUMENT_ID = /^[a-z0-9_-]+$/u;

/**
 * A Server Action is a public HTTP endpoint. Next.js gives it an obscure id rather
 * than a readable URL, but anyone who has seen the page can POST to it directly,
 * with any arguments they like, and the proxy's matcher may not even cover the
 * route it was invoked from. Both the session check and the argument validation
 * therefore belong HERE, on the first lines: not in the proxy, not in the caller.
 */
export async function requestAccess(formData: FormData) {
  const session = await requireSession();
  const documentId = formData.get("documentId");

  if (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId)) {
    redirect("/documents?requested=invalid");
  }

  // Through the DAL, never `findDocument`: resolving it here would confirm the
  // existence of documents this user is not allowed to know about.
  const doc = await getDocumentForCurrentUser(documentId);

  if (!doc) {
    redirect("/documents?requested=invalid");
  }

  // A real app would open a ticket here. The demo just records the intent.
  console.info(`[actions] ${session.email} requested access to "${doc.title}" (${doc.id})`);

  redirect(`/documents?requested=${doc.id}`);
}
