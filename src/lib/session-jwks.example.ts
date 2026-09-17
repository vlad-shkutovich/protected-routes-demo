// src/lib/session-jwks.example.ts
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

import { SessionError } from "@/lib/session";

/**
 * RS256 + JWKS alternative. Written for the article; nothing in the demo imports it.
 *
 * Use this shape when an EXTERNAL identity provider (Auth0, Okta, Entra, Cognito,
 * Keycloak) issues the token: you only ever verify, never sign, so the app holds a
 * public key and the IdP can rotate its signing key without a redeploy —
 * `createRemoteJWKSet` re-fetches and caches the key set by `kid`.
 *
 * The HS256 path in session.ts is the right one when you issue AND verify the token
 * yourself. HS256 stops being appropriate the moment a second service needs to
 * verify, because sharing the secret means sharing the ability to mint tokens.
 */
const ISSUER = process.env.OIDC_ISSUER ?? "https://idp.example.com/";
const AUDIENCE = process.env.OIDC_AUDIENCE ?? "partner-portal";
const JWKS_URL = process.env.OIDC_JWKS_URL ?? "https://idp.example.com/.well-known/jwks.json";

// Lazily created and then reused: the resolver owns the key cache, and building it
// at module load would resolve the URL (and read the env) on every cold start,
// including in processes that never verify a token.
let jwks: JWTVerifyGetKey | undefined;

function getJwks(): JWTVerifyGetKey {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));

  return jwks;
}

/** Only what an external IdP is guaranteed to give you; map it to your own user in the DAL. */
export type ExternalSession = { sub: string; expiresAt: number };

export async function verifySessionWithJwks(token: string): Promise<ExternalSession> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      algorithms: ["RS256"],
      typ: "JWT",
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: "5s",
    });

    const { sub, exp } = payload;

    if (typeof sub !== "string" || typeof exp !== "number") {
      throw new SessionError("sub or exp is missing after verification");
    }

    // No role claim is trusted here: the IdP proves identity, the store decides access.
    return { sub, expiresAt: exp };
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
