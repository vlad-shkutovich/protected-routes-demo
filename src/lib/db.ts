// src/lib/db.ts
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { Role } from "@/lib/session";

/**
 * In-memory stand-in for a real database. Module state survives for the life of
 * a single server process, which is exactly what the revocation demo needs and
 * exactly why you would never do this in production.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

export type User = {
  id: string;
  email: string;
  /** `<salt hex>:<derived key hex>`. Never leaves this module. */
  passwordHash: string;
  role: Role;
};

export type Document = {
  id: string;
  title: string;
  /** Minimum role needed to see and download this document. */
  requiredRole: Role;
  /** Path under `public/`, served statically once access has been granted. */
  fileName: string;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);

  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");

  if (!(saltHex && keyHex)) {
    // A malformed hash is a data bug, not a wrong password — say so in the log.
    console.error("[db] stored password hash is malformed");
    return false;
  }

  let derived: Buffer;

  try {
    derived = await scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
  } catch (error) {
    console.error("[db] scrypt failed while verifying a password:", error);
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");

  if (expected.length !== derived.length) {
    return false;
  }

  return timingSafeEqual(expected, derived);
}

const SEED_PASSWORD = "password123";

const users = new Map<string, User>();

const documents: Document[] = [
  {
    id: "brochure",
    title: "Partner Programme Brochure",
    requiredRole: "member",
    fileName: "public-brochure.txt",
  },
  {
    id: "pricing",
    title: "2026 Partner Pricing Sheet",
    requiredRole: "partner",
    fileName: "partner-pricing.txt",
  },
  {
    id: "audit",
    title: "Internal Audit Report",
    requiredRole: "admin",
    fileName: "internal-audit.txt",
  },
];

/**
 * Seeding is async (scrypt is), so every read goes through `ready()`. In a real
 * app this is your connection pool; here it just guarantees the three seed users
 * exist before the first query.
 */
let seeding: Promise<void> | null = null;

function seed(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      const seeds: Array<{ id: string; email: string; role: Role }> = [
        { id: "u_member", email: "member@example.com", role: "member" },
        { id: "u_partner", email: "partner@example.com", role: "partner" },
        { id: "u_admin", email: "admin@example.com", role: "admin" },
      ];

      for (const entry of seeds) {
        users.set(entry.id, {
          ...entry,
          passwordHash: await hashPassword(SEED_PASSWORD),
        });
      }
    })();
  }

  return seeding;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  await seed();
  const normalized = email.trim().toLowerCase();

  for (const user of users.values()) {
    if (user.email === normalized) {
      return user;
    }
  }

  return null;
}

export async function findUserById(id: string): Promise<User | null> {
  await seed();

  return users.get(id) ?? null;
}

/**
 * Used by the dev-only revocation endpoint. Deleting a user does NOT invalidate
 * the JWT they are holding — that is the whole point of the demo.
 */
export async function deleteUser(id: string): Promise<boolean> {
  await seed();

  return users.delete(id);
}

export async function listDocuments(): Promise<Document[]> {
  await seed();

  return documents;
}

export async function findDocument(id: string): Promise<Document | null> {
  await seed();

  return documents.find((doc) => doc.id === id) ?? null;
}
