// src/app/documents/actions.ts
"use server";

import { requireSession } from "@/lib/dal";
import { findDocument } from "@/lib/db";

export type RequestAccessResult = { ok: boolean; message: string };

/**
 * A Server Action is a public HTTP endpoint. Next.js gives it an obscure id rather
 * than a readable URL, but anyone who has seen the page can POST to it directly,
 * and the proxy's matcher may not even cover the route it was invoked from. The
 * session check therefore belongs HERE, on the first line — not in the proxy.
 */
export async function requestAccess(documentId: string): Promise<RequestAccessResult> {
  const session = await requireSession();
  const doc = await findDocument(documentId);

  if (!doc) {
    return { ok: false, message: "No such document." };
  }

  // A real app would open a ticket here. The demo just records the intent.
  console.info(`[actions] ${session.email} requested access to "${doc.title}" (${doc.id})`);

  return { ok: true, message: `Access to "${doc.title}" requested.` };
}
