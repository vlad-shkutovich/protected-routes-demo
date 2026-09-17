// src/lib/db.ts
import "server-only";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { Role } from "@/lib/session";

/**
 * In-memory stand-in for a real database. Module state survives for the life of
 * a single server process, which is exactly what the revocation demo needs and
 * exactly why you would never do this in production.
 */

type ScryptParams = { N: number; r: number; p: number };

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams & { maxmem: number },
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

/**
 * Cost parameters for new hashes. They are stored alongside every hash, so raising
 * them later does not invalidate the records written with the old ones.
 * scrypt needs roughly `128 * N * r` bytes: 128 MiB here, above Node's 32 MiB
 * default, so `maxmem` has to be raised or the call throws.
 */
const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** A well-formed record for a value nothing can guess, so the "unknown email" branch costs the same. */
const DUMMY_HASH = formatHash(SCRYPT_PARAMS, Buffer.alloc(16), Buffer.alloc(SCRYPT_KEYLEN));

function formatHash(params: ScryptParams, salt: Buffer, derived: Buffer): string {
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** `scrypt$N$r$p$<salt hex>$<key hex>` — the verifier reads the cost out of the record. */
function parseHash(
  stored: string,
): { params: ScryptParams; salt: Buffer; expected: Buffer } | null {
  const [scheme, n, r, p, saltHex, keyHex] = stored.split("$");

  if (scheme !== "scrypt" || !(n && r && p && saltHex && keyHex)) {
    return null;
  }

  const params = { N: Number(n), r: Number(r), p: Number(p) };

  if (!Object.values(params).every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }

  return { params, salt: Buffer.from(saltHex, "hex"), expected: Buffer.from(keyHex, "hex") };
}

export type User = {
  id: string;
  email: string;
  /** Never leaves this module. */
  passwordHash: string;
  role: Role;
};

export type Document = {
  id: string;
  title: string;
  /** Minimum role needed to see and download this document. */
  requiredRole: Role;
  /** File under `content/files/`, outside `public/` so only the download route can serve it. */
  fileName: string;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });

  return formatHash(SCRYPT_PARAMS, salt, derived);
}

/**
 * `stored` is nullable on purpose: the login paths call this even when no user
 * matched, passing `null`. Returning early for an unknown email would make the
 * response measurably faster than a wrong password and turn the timing into an
 * account-enumeration oracle, so an unknown email still pays for one scrypt run.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const record = parseHash(stored ?? DUMMY_HASH);

  if (!record) {
    // A malformed hash is a data bug, not a wrong password — say so in the log.
    console.error("[db] stored password hash is malformed");
    return false;
  }

  let derived: Buffer;

  try {
    derived = await scrypt(password, record.salt, record.expected.length, {
      ...record.params,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch (error) {
    console.error("[db] scrypt failed while verifying a password:", error);
    return false;
  }

  if (record.expected.length !== derived.length) {
    return false;
  }

  // Constant-time: a byte-by-byte `===` leaks how much of the hash matched.
  return timingSafeEqual(record.expected, derived);
}

const SEED_PASSWORD = "password123";

/**
 * The store lives on `globalThis`, not in a module-level `const`.
 *
 * In dev, module state written from a Route Handler turned out not to be visible
 * to a Server Component — a plain module-level Map gave two different in-memory
 * databases and quietly broke the revocation demo (VERIFICATION.md, gotcha 1).
 * `globalThis` is one object per process, so both paths see the same store. It is
 * the same reason every Next.js + Prisma guide caches its client here.
 */
const globalStore = globalThis as typeof globalThis & {
  __partnerPortalUsers?: Map<string, User>;
};

globalStore.__partnerPortalUsers ??= new Map<string, User>();

const users = globalStore.__partnerPortalUsers;

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
const globalSeed = globalThis as typeof globalThis & {
  __partnerPortalSeed?: Promise<void>;
};

function seed(): Promise<void> {
  if (!globalSeed.__partnerPortalSeed) {
    globalSeed.__partnerPortalSeed = (async () => {
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

  return globalSeed.__partnerPortalSeed;
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
