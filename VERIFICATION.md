# Verification log

Everything below was re-run against this repository on 2026-09-17, after the security review.
Output is trimmed to the interesting headers; nothing is reconstructed from memory.

## Versions (from `package-lock.json`)

```
$ node -e "const l=require('./package-lock.json').packages; for (const k of ['node_modules/next','node_modules/jose','node_modules/react','node_modules/server-only']) console.log(k, l[k].version)"
node_modules/next 16.3.5
node_modules/jose 6.2.12
node_modules/react 19.2.8
node_modules/server-only 0.0.1
```

## Static checks

| Command             | Result                                                        |
| ------------------- | ------------------------------------------------------------- |
| `npm run typecheck` | clean (no output)                                             |
| `npm run lint`      | `Found 0 warnings and 0 errors.` (21 files, 324 rules)        |
| `npm run build`     | `✓ Compiled successfully`, 10 routes + `ƒ Proxy (Middleware)` |

`next build` route table:

```
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /admin
├ ƒ /api/auth/login
├ ƒ /api/auth/logout
├ ƒ /api/dev/revoke
├ ƒ /api/me
├ ƒ /documents
├ ƒ /documents/[id]/download
└ ƒ /login

ƒ Proxy (Middleware)
```

Note that 16.3.5 still labels the row `ƒ Proxy (Middleware)` — the old name is kept in
parentheses in the build output.

## Boot-time configuration checks

`src/lib/session.ts` reads its configuration at module load, and route collection imports it,
so all three of these fail the **build**, not the first request:

```
$ env -u JWT_SECRET npx next build
Error: Failed to collect configuration for /api/auth/logout
  [cause]: Error: JWT_SECRET is not set. Copy .env.example to .env.local and generate a secret.

$ JWT_SECRET=$(openssl rand -hex 16) npx next build
  [cause]: Error: JWT_SECRET is too weak (16 bytes of key material). HS256 needs at least 32; run: openssl rand -hex 32

$ SESSION_TTL_SECONDS= npx next build
  [cause]: Error: SESSION_TTL_SECONDS must be a positive integer, got "".
```

A 32-character hex string is 16 bytes, and it is rejected — the check counts key material, not
characters. A non-hex passphrase is measured as UTF-8 bytes:
`JWT_SECRET="correct horse battery staple correct horse" npx next build` → `✓ Compiled successfully`.

## Runtime checks (`next build` + `next start -p 4321`, unless noted)

`next start` runs with `NODE_ENV=production`, which is why the cookies below carry `Secure` and
why the dev-only revocation endpoint needed a separate `next dev` run (check i).

### a. Unauthenticated page navigation → redirect preserving the path

```
$ curl -s -o /dev/null -D - http://localhost:4321/documents
HTTP/1.1 307 Temporary Redirect
location: /login?next=%2Fdocuments
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
```

PASS. The status is **307**, not 302: `NextResponse.redirect` defaults to 307. The three
security headers come from `next.config.ts`; `x-powered-by` is gone.

### b. Unauthenticated `/api/*` → JSON 401, not a redirect

```
$ curl -s -i http://localhost:4321/api/me
HTTP/1.1 401 Unauthorized
{"error":"unauthorized"}

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/api/documents/anything
401
```

PASS — including for a path with no route handler behind it, because the proxy answers first.

### c. Login sets the session cookie

```
$ curl -s -i -X POST http://localhost:4321/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"member@example.com","password":"password123"}' -c member.jar
HTTP/1.1 200 OK
set-cookie: session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; Expires=Thu, 17 Sep 2026 12:07:35 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=lax
```

PASS: `HttpOnly`, `SameSite=lax`, `Path=/`, `Max-Age` equal to the token lifetime. `Secure` is
present here because this is a production build; under `next dev` it is absent, since a
`Secure` cookie on `http://localhost` would be dropped by older browsers.

Decoded payload: `{"role":"member","authTime":1789643255,"sub":"u_member","iss":...,"exp":...}`.

### d. Authenticated page lists only what the role allows

```
$ curl -s -D - -b member.jar http://localhost:4321/documents
HTTP/1.1 200 OK
```

The body contains `Signed in as member@example.com (member)` and **one** document,
`Partner Programme Brochure`. The strings `2026 Partner Pricing Sheet` and
`Internal Audit Report` do not appear anywhere in it. PASS — the page used to render the
titles of documents above the user's role under a "Not available to your role" heading.

### e. Partner-only download as a member → 204, empty body

```
$ curl -s -o body.bin -D - -b member.jar http://localhost:4321/documents/pricing/download
HTTP/1.1 204 No Content
$ wc -c < body.bin
0
```

Server log: `[dal] member@example.com (member) denied document pricing`. PASS.

### f. Same download as a partner → the bytes, as an attachment

```
$ curl -s -D - -b partner.jar http://localhost:4321/documents/pricing/download
HTTP/1.1 200 OK
content-type: text/plain; charset=utf-8
content-disposition: attachment; filename="partner-pricing.txt"

Partner Portal — 2026 Partner Pricing Sheet
===========================================
Confidential. Requires the `partner` role (admins inherit access).
```

PASS. As admin, `/documents/audit/download` returns `200` with
`content-disposition: attachment; filename="internal-audit.txt"`.

### f2. The old static path is gone

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4321/files/internal-audit.txt
404
```

PASS, and this is the review's most serious finding. The files used to live in
`public/files/`, where Next serves them by path with no session in sight, and the proxy
matcher excludes anything with a file extension — so an unauthenticated
`curl /files/internal-audit.txt` returned the admin-only document in full. They now live in
`content/files/`, and the download route is the only reader.

### g. `/admin`

```
$ curl -s -o /dev/null -D - -b member.jar http://localhost:4321/admin
HTTP/1.1 307 Temporary Redirect
location: /documents

$ curl -s -o /dev/null -w "%{http_code}\n" -b admin.jar http://localhost:4321/admin
200
```

Server log for the member: `[dal] member@example.com (member) denied: needs admin`.

**Design choice, documented as asked:** a signed-in user who lacks the role is _redirected to
`/documents`_, not shown a 403 and not given a 404. Rationale: they are authenticated, the page
exists, and a redirect to a page they can actually use is the least confusing outcome. A 404
would be the right call if the existence of `/admin` were itself confidential; it is not here.
Next.js 16.3 does ship `forbidden()` / `unauthorized()` for the 403/401 route, but both are
**experimental** and require `experimental.authInterrupts: true` in `next.config.ts`
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/forbidden.md`, line 17), so
the demo stays on the redirect path the article describes.

### h. Tampered token

Flipped the last character of the JWT and replayed it:

```
$ curl -s -o /dev/null -D - -H "Cookie: session=${BAD}" http://localhost:4321/documents
HTTP/1.1 307 Temporary Redirect
location: /login?next=%2Fdocuments
```

Server log:

```
[proxy] /documents rejected: rO (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)
```

PASS — fail closed, and the reason is in the log rather than in the response. Note the class
name is minified to `rO` in a production build; under `next dev` the same line reads
`JWSSignatureVerificationFailed`. The `code` is what you log against.

### h2. Cross-site POST to the auth endpoints → 403

The auth endpoints are excluded from the proxy matcher (a signed-out user has to reach them),
so they carry their own check in `assertSameOrigin` (`src/lib/auth.ts`).

```
$ curl -s -i -X POST .../api/auth/login -H 'Origin: https://evil.example' \
    -H 'content-type: application/json' -d '{"email":"member@example.com","password":"password123"}'
HTTP/1.1 403 Forbidden
{"error":"cross-origin request rejected"}

$ curl -s -i -X POST .../api/auth/logout -H 'Origin: https://evil.example' -b member.jar
HTTP/1.1 403 Forbidden
{"error":"cross-origin request rejected"}

$ curl -s -i -X POST .../api/auth/logout -H 'Origin: http://localhost:4321' -b member.jar
HTTP/1.1 200 OK
set-cookie: session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax
```

PASS. Before the fix both returned `200`: login would have let an attacker's page force a
victim into the attacker's session, and logout was a free denial of service.

### h3. The Server Action is reachable, validated and DAL-bound

Driven through a real browser, because a Server Action is invoked with an encoded argument
list that `curl` cannot usefully hand-roll (a hand-made body gets `TypeError: a.get is not a
function` — the handler received something that is not a `FormData`).

```
click "Request a fresh copy" -> http://localhost:4321/documents?requested=brochure
  page: "Access request recorded: brochure"
  log:  [actions] member@example.com requested access to "Partner Programme Brochure" (brochure)

hidden input tampered to "audit"  -> /documents?requested=invalid
  log: [dal] member@example.com (member) denied document audit

hidden input tampered to "../../etc/passwd" -> /documents?requested=invalid
  log: (nothing — the id fails /^[a-z0-9_-]+$/u before the store is touched)

POST to the action with no session cookie -> 307 (the proxy answers first)
```

PASS. The action was previously dead code, called from nowhere and resolving documents with
`findDocument`, which ignores the role.

### i2. Open redirect in the `next` parameter

`src/app/login/page.tsx` validates `?next=` before redirecting. Re-run unchanged:

```
next=%2F%5Cevil.com        -> location: /documents
next=%2F%2Fevil.com        -> location: /documents
next=%2F..%2F%2Fevil.com   -> location: /documents
next=https%3A%2F%2Fevil.com -> location: /documents
next=%2Fadmin              -> location: /admin
next=%2Fdocuments%3Fa%3D1  -> location: /documents?a=1
```

PASS. The history behind that check: `startsWith("/")` is not enough, because the WHATWG URL
parser treats a backslash as a slash (`/\evil.example` → `http://evil.example/`); and the
origin comparison alone is not enough either, because dot segments are resolved before the
authority, so `/..//evil.example` stays on the probe origin and comes back with the pathname
`//evil.example`. The final check demands exactly one leading slash on the string that goes
into the `Location` header.

### i3. Login timing is the same for an unknown email and a wrong password

```
unknown email   401 0.294250s
wrong password  401 0.262259s
```

PASS. The absolute numbers are ten times the earlier run because scrypt now uses
`{ N: 2**17, r: 8, p: 1 }` (~128 MiB, `maxmem` raised to 256 MiB) instead of Node's defaults.

### i. Revocation — the key demonstration

Run under `next dev -p 4324`: `/api/dev/revoke` returns `404` when `NODE_ENV=production`, and
it now also requires an `admin` session.

```
$ curl -s -i -X POST .../api/dev/revoke -b member.jar -d '{"userId":"u_member"}'
HTTP/1.1 403 Forbidden
{"error":"forbidden"}

$ curl -s -o /dev/null -D - -b member.jar .../documents
HTTP/1.1 200 OK

$ curl -s -X POST .../api/dev/revoke -H 'content-type: application/json' \
    -b admin.jar -d '{"userId":"u_member"}'
{"deleted":true}

$ curl -s -o /dev/null -D - -b member.jar .../documents
HTTP/1.1 307 Temporary Redirect
location: /login

$ curl -s -o /dev/null -w "%{http_code}\n" -b member.jar .../api/me
401
```

Server log:

```
[proxy] /api/dev/revoke passed the optimistic check for u_admin
[dev/revoke] admin@example.com deleted u_member -> true
[proxy] /documents passed the optimistic check for u_member      <-- proxy still says yes
[dal] valid token for unknown user u_member — treating as signed out   <-- DAL says no
```

PASS, and this is the whole argument: the proxy let the request through _after_ the account
was deleted, because the token is still cryptographically valid. Only the DAL, which touches
the store, could tell. The member's cookie is untouched throughout.

### j. Sliding session, and the ceiling that stops it

Started with `SESSION_TTL_SECONDS=300`, so every freshly issued token sits below the 10-minute
refresh threshold and the proxy re-issues on the next request.

```
$ SESSION_TTL_SECONDS=300 npx next start -p 4322
$ curl -s -X POST .../api/auth/login ... -c slide.jar
iat=1789643541 exp=1789643841 authTime=1789643541 ttl=300
$ curl -s -o /dev/null -D - -b slide.jar -c slide.jar .../documents
HTTP/1.1 200 OK
set-cookie: session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Max-Age=300; ...
iat=1789643543 exp=1789643843 authTime=1789643541 ttl=300
```

PASS — a plain page navigation carried a brand-new token with a later `exp`, and `authTime` is
byte-identical across the re-issue. That claim is what caps the slide:

```
$ SESSION_TTL_SECONDS=300 MAX_SESSION_SECONDS=1 npx next start -p 4323
$ curl -s -X POST .../api/auth/login ... -c cap.jar
iat=1789643551 exp=1789643851 authTime=1789643551 ttl=300
# three seconds later, past authTime + MAX_SESSION_SECONDS:
$ curl -s -o /dev/null -D - -b cap.jar .../documents
HTTP/1.1 200 OK
(no set-cookie header at all)
```

PASS. The request still succeeds — the current token is valid until its `exp` — but nothing is
re-issued, so the session ends on schedule instead of sliding forever. Default ceiling: 8h.

## The `middleware.ts` deprecation warning, verbatim

Reproduced by moving `src/proxy.ts` aside and copying `examples/next-15/middleware.ts` to
`src/middleware.ts`. Next.js 16.3.5 prints this, identically in `next dev` and `next build`:

```
 ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

  To migrate automatically, run:
  npx @next/codemod@canary middleware-to-proxy .

  Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
```

(The leading glyph is `⚠` followed by a space.) `proxy.ts` was restored afterwards; `src/` now
contains `app/`, `lib/` and `proxy.ts` only.

With **both** files present, `next build` refuses to build:

```
> Build error occurred
Error: Both middleware file "./src/src/middleware.ts" and proxy file "./src/src/proxy.ts" are detected. Please use "./src/src/proxy.ts" only. Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
```

## The codemod, as the bundled docs write it

Two bundled files give the command, and **they disagree on the dist-tag**:

- `node_modules/next/dist/docs/01-app/02-guides/upgrading/codemods.md`, line 160:
  ```bash
  npx @next/codemod@latest middleware-to-proxy .
  ```
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, line 790
  (and `.../03-file-conventions/middleware.md`, line 18):
  ```bash
  npx @next/codemod@canary middleware-to-proxy .
  ```

The runtime warning quoted above prints the `@canary` form. `@latest` is the one to put in an
article; `@canary` is what the deprecation message and the API reference say.

## `skipMiddleware*` → `skipProxy*` renames, as the bundled docs state them

From `node_modules/next/dist/docs/01-app/02-guides/upgrading/codemods.md`, lines 167–170 — the
complete list the codemod performs:

| Old                                              | New                                         |
| ------------------------------------------------ | ------------------------------------------- |
| `experimental.middlewarePrefetch`                | `experimental.proxyPrefetch`                |
| `experimental.middlewareClientMaxBodySize`       | `experimental.proxyClientMaxBodySize`       |
| `experimental.externalMiddlewareRewritesResolve` | `experimental.externalProxyRewritesResolve` |
| `skipMiddlewareUrlNormalize`                     | `skipProxyUrlNormalize`                     |

`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` line 637 names only
`skipMiddlewareUrlNormalize → skipProxyUrlNormalize` as an example. `.../05-config/01-next-config-js/skipProxyUrlNormalize.md`
line 51 adds the compatibility rule:

> The former name of this option is `skipMiddlewareUrlNormalize`, from when Proxy was called
> Middleware. It still works and logs a deprecation warning. Setting both at once throws:
> `Config options 'skipProxyUrlNormalize' and 'skipMiddlewareUrlNormalize' cannot be set at the same time. Please use 'skipProxyUrlNormalize' instead.`

There is no `skipMiddlewareTrailingSlashRedirect`: the trailing-slash flag was always called
`skipTrailingSlashRedirect` and was **not** renamed
(`.../03-file-conventions/proxy.md`, line 259).

## Is `runtime: 'edge'` still allowed in `proxy.ts`?

**No.** Two bundled sources, both unambiguous:

- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, line 255:
  > Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in
  > Proxy files. Setting the `runtime` config option in Proxy will throw an error.
- `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`, line 616:
  > The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is `nodejs`, and it
  > cannot be configured. If you want to continue using the `edge` runtime, keep using
  > `middleware`. We will follow up on a minor release with further `edge` runtime instructions.

So the deprecated `middleware.ts` is, for now, the _only_ documented way to keep the edge
runtime — the deprecation and the feature matrix point in opposite directions.

## Gotchas hit while building against 16.3.5

1. **A module-level `Map` is not one store.** The revocation demo failed on the first attempt:
   `POST /api/dev/revoke` deleted the user, `/api/me` correctly returned `401`, and
   `/documents` still rendered the full document list. In dev, module state written from the
   Route Handler was not visible on the RSC path — a module-level `const users = new Map()`
   behaved as _two different databases_. The bundled docs do not explain the mechanism; what
   is certain is the fix: hanging the store off `globalThis` (`src/lib/db.ts`) made both paths
   agree, the same reason every Next.js + Prisma guide caches its client there. Easy to
   mistake for a caching bug and burn an hour on.

2. **`LayoutProps<"/">` does not exist until you have built once.** The scaffold's
   `src/app/layout.tsx` uses it, and `npm run typecheck` on a clean checkout fails with
   `TS2304: Cannot find name 'LayoutProps'`. The type is generated into `.next/types` by
   `next build` / `next dev`. Any CI that runs `tsc --noEmit` before `next build` breaks.

3. **`NextResponse.redirect` is 307, not 302.** Worth stating if an article promises "a 302 to
   the login page".

4. **The build output still says `ƒ Proxy (Middleware)`.** The rename is not complete in the
   CLI surface, which makes it harder to tell whether your `proxy.ts` was picked up at all.

5. **The "both files" build error prints a doubled path** — `"./src/src/middleware.ts"` in a
   project using `src/`. Cosmetic, but it sends you looking for a `src/src` directory you never
   created.

6. **The codemod dist-tag differs between bundled doc pages** (`@latest` vs `@canary`), see
   above. Neither page is marked stale.

7. **jose 6 needs an explicit `JWTVerifyResult` annotation** if you want to declare the result
   variable before the `try`. `let result: Awaited<ReturnType<typeof jwtVerify>>` does not
   type-check — the generic default resolves to `JWTVerifyResult<unknown>` and the assignment is
   rejected. Import the type: `import type { JWTVerifyResult } from "jose"`.

8. **The matcher regex has to exclude `/` by construction, not by listing it.** A negative
   lookahead cannot express "not the empty path", so the pattern ends in `.+` rather than `.*`:
   `/((?!...).+)`. `.+` requires at least one character after the leading slash, which is what
   keeps `/` itself out of the match; with `.*` the landing page would be protected too.

9. **`cookies()`, `params` and `searchParams` are all Promises** in Next.js 15+. Verified here:
   `src/lib/dal.ts` awaits `cookies()`, `src/app/login/page.tsx` types `searchParams` as
   `Promise<...>` and `src/app/documents/[id]/download/route.ts` awaits `params`. Any snippet
   written against Next.js 14 will need all three touched.

10. **`forbidden()` and `unauthorized()` are experimental in 16.3.** They need
    `experimental.authInterrupts: true` in `next.config.ts`; without it the call throws. An
    article that presents them as the modern replacement for a redirect should say so.

11. **A Server Action cannot be exercised with hand-written `curl`.** The `Next-Action` header
    is only half of it: the body is an encoded argument list, and a plausible-looking
    `multipart/form-data` payload reaches the handler as something that is not a `FormData`
    (`TypeError: a.get is not a function`, HTTP 500). Drive it from a browser, or from the
    JS-less form fallback Next renders.
