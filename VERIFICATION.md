# Verification log

Everything below was run against this repository on 2026-09-17. Output is trimmed to the
interesting headers; nothing is reconstructed from memory.

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
| `npm run lint`      | `Found 0 warnings and 0 errors.` (19 files, 324 rules)        |
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

## Runtime checks (`next dev` on a free port)

### a. Unauthenticated page navigation → redirect preserving the path

```
$ curl -s -o /dev/null -D - http://localhost:4311/documents
HTTP/1.1 307 Temporary Redirect
location: /login?next=%2Fdocuments
```

PASS. Note the status is **307**, not 302: `NextResponse.redirect` defaults to 307.

### b. Unauthenticated `/api/*` → JSON 401, not a redirect

```
$ curl -s -i http://localhost:4311/api/me
HTTP/1.1 401 Unauthorized
content-type: application/json

{"error":"unauthorized"}

$ curl -s -i http://localhost:4311/api/documents/anything
HTTP/1.1 401 Unauthorized
content-type: application/json

{"error":"unauthorized"}
```

PASS — including for a path with no route handler behind it, because the proxy answers first.

### c. Login sets the session cookie

```
$ curl -s -i -X POST http://localhost:4311/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"member@example.com","password":"password123"}' -c member.jar
HTTP/1.1 200 OK
set-cookie: session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; Expires=Thu, 17 Sep 2026 11:29:43 GMT; Max-Age=3600; HttpOnly; SameSite=lax
```

PASS: `HttpOnly`, `SameSite=lax`, `Path=/`, `Max-Age` equal to the token lifetime. `Secure` is
absent because `NODE_ENV !== 'production'`; on `http://localhost` a `Secure` cookie would be
dropped by the browser.

### d. Authenticated page

```
$ curl -s -o /dev/null -D - -b member.jar http://localhost:4311/documents
HTTP/1.1 200 OK
```

PASS. Body contains `Signed in as member@example.com (member)`, the brochure under
"Documents" and the pricing sheet + audit report under "Not available to your role".

### e. Partner-only download as a member → 204, empty body

```
$ curl -s -o body.bin -D - -b member.jar http://localhost:4311/documents/pricing/download
HTTP/1.1 204 No Content
$ wc -c < body.bin
0
```

Server log: `[dal] member@example.com (member) denied document pricing`. PASS.

### f. Same download as a partner → 302 with an absolute same-origin Location

```
$ curl -s -o /dev/null -D - -b partner.jar http://localhost:4311/documents/pricing/download
HTTP/1.1 302 Found
location: http://localhost:4311/files/partner-pricing.txt

$ curl -s -L -b partner.jar http://localhost:4311/documents/pricing/download
Partner Portal — 2026 Partner Pricing Sheet
```

PASS.

### g. `/admin`

```
$ curl -s -o /dev/null -D - -b member.jar http://localhost:4311/admin
HTTP/1.1 307 Temporary Redirect
location: /documents

$ curl -s -o /dev/null -D - -b admin.jar http://localhost:4311/admin
HTTP/1.1 200 OK
```

Server log for the member: `[dal] member@example.com (member) denied: needs admin`.

**Design choice, documented as asked:** a signed-in user who lacks the role is _redirected to
`/documents`_, not shown a 403 and not given a 404. Rationale: they are authenticated, the page
exists, and a redirect to a page they can actually use is the least confusing outcome. A 404
would be the right call if the existence of `/admin` were itself confidential; it is not here.
Next.js 16 also ships `forbidden()` / `unauthorized()` for the 403/401 route — deliberately not
used, so the demo stays on the redirect path the article describes.

### h. Tampered token

Flipped the last character of the JWT and replayed it:

```
$ curl -s -o /dev/null -D - -H "Cookie: session=${BAD}" http://localhost:4311/documents
HTTP/1.1 307 Temporary Redirect
location: /login?next=%2Fdocuments
```

Server log, with the jose error class and code:

```
[proxy] /documents rejected: JWSSignatureVerificationFailed (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)
```

PASS — fail closed, and the reason is in the log rather than in the response.

### i. Revocation — the key demonstration

How it was triggered: `POST /api/dev/revoke` with `{"userId":"u_member"}`
(`src/app/api/dev/revoke/route.ts`, `404` when `NODE_ENV=production`) calls `deleteUser` on the
in-memory store. The cookie is **not** touched: the client keeps a signed, unexpired, correctly
issued JWT for an account that no longer exists.

```
$ curl -s -X POST .../api/auth/login -d '{"email":"member@example.com","password":"password123"}' -c member.jar
$ curl -s -o /dev/null -D - -b member.jar .../documents
HTTP/1.1 200 OK

$ curl -s -X POST .../api/dev/revoke -H 'content-type: application/json' -b member.jar -d '{"userId":"u_member"}'
{"deleted":true}

$ curl -s -o /dev/null -D - -b member.jar .../documents
HTTP/1.1 307 Temporary Redirect
location: /login
```

Server log across those three requests:

```
[proxy] /documents passed the optimistic check for u_member
[proxy] /api/dev/revoke passed the optimistic check for u_member
[dev/revoke] deleteUser(u_member) -> true
[proxy] /documents passed the optimistic check for u_member      <-- proxy still says yes
[dal] valid token for unknown user u_member — treating as signed out   <-- DAL says no
```

PASS, and this is the whole argument: the proxy let the request through _after_ the account was
deleted, because the token is still cryptographically valid. Only the DAL, which touches the
store, could tell. `GET /api/me` with the same cookie returns `401` for the same reason.

### i2. Open redirect in the `next` parameter

`src/app/login/page.tsx` validates `?next=` before redirecting. The first version only checked
`startsWith("/")` and `!startsWith("//")`, which is **not** enough: the WHATWG URL parser treats
a backslash as a slash, so `/\evil.example` resolves to `http://evil.example/`. Reproduced
before the fix, signed in, on `/login?next=%2F%5Cevil.example`:

```
HTTP/1.1 307 Temporary Redirect
location: /\evil.example          <-- the browser navigates off-site
```

After resolving the value against a probe origin and comparing origins:

```
next=%2F%5Cevil.example          -> location: /documents
next=%2F%2Fevil.example          -> location: /documents
next=https%3A%2F%2Fevil.example  -> location: /documents
next=%2Fadmin                    -> location: /admin
next=%2Fdocuments%3Fa%3D1        -> location: /documents?a=1
```

A second round found that the origin check alone is still not enough: dot segments are resolved
before the authority is parsed, so `/..//evil.example` stays on the probe origin and returns the
pathname `//evil.example` — protocol-relative again.

```
next=%2F..%2F%2Fevil.com  -> location: //evil.com     <-- before the second fix
next=%2F.%2F%2Fevil.com   -> location: //evil.com
```

The final check also demands exactly one leading slash on the string that goes into the
`Location` header:

```
next=%2F..%2F%2Fevil.com  -> location: /documents
next=%2F.%2F%2Fevil.com   -> location: /documents
next=%2F%2Fevil.com       -> location: /documents
next=%2F%5Cevil.com       -> location: /documents
next=%2Fadmin             -> location: /admin
next=%2Fdocuments%3Fa%3D1 -> location: /documents?a=1
```

PASS.

### i3. Login timing is the same for an unknown email and a wrong password

`verifyPassword` takes `string | null` and runs scrypt against a dummy hash when no user
matched, so the response time does not answer "does this account exist?".

```
unknown-user 401 0.025025s
wrong-pass   401 0.025370s
```

PASS.

### j. Sliding session

Started the dev server with `SESSION_TTL_SECONDS=300`, so every freshly issued token sits below
the 10-minute refresh threshold and the proxy re-issues on the next request.

```
$ SESSION_TTL_SECONDS=300 npx next dev -p 4312
$ curl -s -X POST .../api/auth/login ... -c slide.jar
$ curl -s -o /dev/null -D - -b slide.jar .../documents
HTTP/1.1 200 OK
set-cookie: session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; Expires=...; Max-Age=300; HttpOnly; SameSite=lax
```

Decoding both tokens:

```
old iat/exp: 1789641146 1789641446 -> ttl 300
new iat/exp: 1789641153 1789641453 -> ttl 300
token changed: true
```

PASS — a plain page navigation carried a brand-new token with a later `exp`.

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
   `/documents` still rendered the full document list. Next.js evaluates Route Handlers and
   React Server Components in separate module registries, so a module-level `const users = new Map()`
   becomes _two different databases_ and a write from a route handler is invisible to a page.
   Fixed by hanging the store off `globalThis` (`src/lib/db.ts`) — the same reason every
   Next.js + Prisma guide caches its client there. This one is easy to mistake for a caching bug
   and burn an hour on.

2. **`LayoutProps<"/">` does not exist until you have built once.** The scaffold's
   `src/app/layout.tsx` uses it, and `npm run typecheck` on a clean checkout fails with
   `TS2304: Cannot find name 'LayoutProps'`. The type is generated into `.next/types` by
   `next build` / `next dev`. Any CI that runs `tsc --noEmit` before `next build` breaks.

3. **`NextResponse.redirect` is 307, not 302.** Worth stating if an article promises "a 302 to
   the login page". The download route asks for `302` explicitly (`NextResponse.redirect(url, 302)`)
   because that is what a download link should send.

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
