// src/lib/dal.ts
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { findDocument, findUserById, listDocuments } from "@/lib/db";
import type { Document } from "@/lib/db";
import { SESSION_COOKIE, SessionError, verifySession } from "@/lib/session";
import type { Role } from "@/lib/session";

/**
 * The Data Access Layer. Everything that renders or returns data goes through
 * here, and every function re-checks the session against the database. The proxy
 * is an optimistic filter; this is the authority.
 */

/** What callers are allowed to see. The `passwordHash` never crosses this boundary. */
export type SessionUser = {
  id: string;
  email: string;
  role: Role;
};

export type DocumentDto = {
  id: string;
  title: string;
  requiredRole: Role;
};

const ROLE_RANK: Record<Role, number> = { member: 0, partner: 1, admin: 2 };

function canAccess(userRole: Role, requiredRole: Role): boolean {
  return ROLE_RANK[userRole] >= ROLE_RANK[requiredRole];
}

function toDocumentDto(doc: Document): DocumentDto {
  return { id: doc.id, title: doc.title, requiredRole: doc.requiredRole };
}

/**
 * `cache()` dedupes this per request: a layout, a page and three components can
 * all call `getSession()` and the cookie is parsed, the JWT verified and the user
 * looked up exactly once.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  // `cookies()` is async in Next.js 15+ — awaiting it is not optional.
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  let sub: string;

  try {
    sub = (await verifySession(token)).payload.sub;
  } catch (error) {
    if (error instanceof SessionError) {
      console.warn(`[dal] rejecting session cookie: ${error.reason}`);
    } else {
      console.error("[dal] unexpected error verifying the session cookie:", error);
    }

    return null;
  }

  // The token can be perfectly valid and the user still gone. A JWT is a claim
  // about the past; only the store knows whether the account still exists.
  const user = await findUserById(sub);

  if (!user) {
    console.warn(`[dal] valid token for unknown user ${sub} — treating as signed out`);
    return null;
  }

  return { id: user.id, email: user.email, role: user.role };
});

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return session;
}

/**
 * Role check against the DB row, not against the `role` claim in the token. If an
 * admin is demoted, the token they are still holding says "admin"; the store says
 * otherwise, and the store wins.
 */
export async function requireRole(role: Role): Promise<SessionUser> {
  const session = await requireSession();

  if (!canAccess(session.role, role)) {
    console.warn(`[dal] ${session.email} (${session.role}) denied: needs ${role}`);
    redirect("/documents");
  }

  return session;
}

export async function getDocumentsForCurrentUser(): Promise<DocumentDto[]> {
  const session = await getSession();

  if (!session) {
    return [];
  }

  const all = await listDocuments();

  return all.filter((doc) => canAccess(session.role, doc.requiredRole)).map(toDocumentDto);
}

/** Returns null both for "no such document" and "not allowed" — don't leak existence. */
export async function getDocumentForCurrentUser(id: string): Promise<Document | null> {
  const session = await getSession();

  if (!session) {
    return null;
  }

  const doc = await findDocument(id);

  if (!doc) {
    return null;
  }

  if (!canAccess(session.role, doc.requiredRole)) {
    console.warn(`[dal] ${session.email} (${session.role}) denied document ${id}`);
    return null;
  }

  return doc;
}
