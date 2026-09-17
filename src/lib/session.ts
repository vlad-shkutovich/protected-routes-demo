// src/lib/session.ts
import type { JWTVerifyResult } from "jose";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, SignJWT } from "jose";

/**
 * Session constants. `iss` and `aud` are pinned so a token minted for another
 * service (or another environment) cannot be replayed against this app.
 */
export const SESSION_COOKIE = "session";
export const SESSION_ISSUER = "https://partner-portal.example.com";
export const SESSION_AUDIENCE = "partner-portal";

/**
 * Token lifetime. Overridable through SESSION_TTL_SECONDS so the sliding-session
 * behaviour can be exercised locally (see VERIFICATION.md, check j) without
 * waiting 50 minutes for a real token to approach its expiry.
 */
export const SESSION_TTL_SECONDS = readTtlSeconds();

function readTtlSeconds(): number {
  const raw = process.env.SESSION_TTL_SECONDS;

  if (raw === undefined) {
    return 3600;
  }

  const parsed = Number.parseInt(raw, 10);

  // `Number.parseInt("nonsense")` is NaN, and a NaN TTL produces a token with an
  // invalid `exp` and a cookie with no Max-Age — a silently broken session rather
  // than a loud misconfiguration. Fail at boot instead.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`SESSION_TTL_SECONDS must be a positive integer, got ${JSON.stringify(raw)}.`);
  }

  return parsed;
}

/** Re-issue the token when it has less than this many seconds left. */
export const SESSION_REFRESH_THRESHOLD_SECONDS = 10 * 60;

export const ROLES = ["member", "partner", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type SessionPayload = {
  sub: string;
  role: Role;
};

/** Thrown by `verifySession` for every failure mode. Callers fail closed on it. */
export class SessionError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(reason: string, cause?: unknown) {
    super(`Session rejected: ${reason}`);
    this.name = "SessionError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Fail fast at module load rather than at the first request: a missing or weak
 * secret is a deployment mistake, and an app that boots with one is an app that
 * silently issues forgeable sessions.
 */
function readSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Copy .env.example to .env.local and generate a secret.",
    );
  }

  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} chars). HS256 needs at least 32 characters of entropy.`,
    );
  }

  return new TextEncoder().encode(secret);
}

const secretKey = readSecret();

/** Runtime narrowing. The claims come off the wire, so they are `unknown` until proven otherwise. */
function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function narrowPayload(claims: Record<string, unknown>): SessionPayload {
  const { sub, role } = claims;

  if (typeof sub !== "string" || sub.length === 0) {
    throw new SessionError("payload.sub is missing or not a string");
  }

  if (!isRole(role)) {
    throw new SessionError(`payload.role is not a known role (got ${JSON.stringify(role)})`);
  }

  // Note the absence of a cast: `sub` and `role` are narrowed by the checks above.
  return { sub, role };
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey);
}

export type VerifiedSession = {
  payload: SessionPayload;
  /** Unix seconds. Present because `exp` is required by the verify options below. */
  expiresAt: number;
};

/**
 * Verifies a compact JWS and returns the narrowed session, or throws `SessionError`.
 * Every caller treats a throw as "no session" — there is no path that keeps going
 * with an unverified token.
 */
export async function verifySession(token: string): Promise<VerifiedSession> {
  let result: JWTVerifyResult;

  try {
    result = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"], // pin the alg: never let the token's header choose it
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
    });
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      // error.code is stable across jose releases; the class name is what shows up in logs.
      throw new SessionError(`${error.constructor.name} (${error.code})`, error);
    }

    throw new SessionError("unexpected verification failure", error);
  }

  const { exp } = result.payload;

  if (typeof exp !== "number") {
    throw new SessionError("payload.exp is missing after verification");
  }

  return { payload: narrowPayload(result.payload), expiresAt: exp };
}

/** True when the token is close enough to expiry that it should be re-issued. */
export function shouldRefresh(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - Math.floor(now / 1000) < SESSION_REFRESH_THRESHOLD_SECONDS;
}

/**
 * RS256 + JWKS alternative. Exported for the article, unused by this demo.
 *
 * Use this shape when an EXTERNAL identity provider (Auth0, Okta, Entra, Cognito,
 * Keycloak) issues the token: you only ever verify, you never sign, so the app
 * holds a public key and the IdP can rotate its signing key without a redeploy —
 * `createRemoteJWKSet` re-fetches and caches the key set by `kid`.
 *
 * Use the HS256 path above when you issue AND verify the token yourself, as this
 * demo does: a shared symmetric secret is simpler, and there is no third party
 * that would need the public half. HS256 stops being appropriate the moment a
 * second service needs to verify, because sharing the secret means sharing the
 * ability to mint tokens.
 */
const remoteJwks = createRemoteJWKSet(
  new URL(process.env.OIDC_JWKS_URL ?? "https://idp.example.com/.well-known/jwks.json"),
);

export async function verifySessionWithJwks(token: string): Promise<VerifiedSession> {
  try {
    const { payload } = await jwtVerify(token, remoteJwks, {
      algorithms: ["RS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      requiredClaims: ["exp", "sub"],
    });

    const exp = payload.exp;

    if (typeof exp !== "number") {
      throw new SessionError("payload.exp is missing after verification");
    }

    return { payload: narrowPayload(payload), expiresAt: exp };
  } catch (error) {
    if (error instanceof SessionError) {
      throw error;
    }

    if (error instanceof joseErrors.JOSEError) {
      throw new SessionError(`${error.constructor.name} (${error.code})`, error);
    }

    throw new SessionError("unexpected JWKS verification failure", error);
  }
}
