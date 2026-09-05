# 10 — Refuse a cross-origin mutation on every route, not only the ones the framework covers

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F8](../../research/2026-09-05-lock-slice-launch-review.md#f8--should-fix--documents-that-state-things-the-code-does-not-do)
item 10 and the bearer-token reviewer's finding under it._

**What to build:** A second root middleware in `app/root.tsx`, ahead of the lock's, that refuses a
mutation request whose `Origin` header is present and names a host other than this instance's,
with a 400 and no body. React Router 7.18.2 runs its own such check (`throwIfPotentialCSRFAttack`)
for document requests and single-fetch actions — and not for resource routes, which is what
`/lock-now`, `/masking` and `/refresh` are. The comment in `lockMiddleware` claims the framework's
check runs "before this middleware for every mutation method" and offers it as the second of two
reasons a forged POST cannot clear a grant; on a resource route it is the only reason that is not
there. The consequence is bounded — `SameSite=Lax` withholds the cookie from a cross-*site* POST,
so what is left is a same-site sibling origin forcing a lock — but the claim is in the code, and
the fix is one function.

Its own ticket because it is a new single-site rule (ARCHITECTURE.md §4.2's table gains a row),
and a reviewer should see it alone.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The middleware**

- [ ] `crossOriginMutationMiddleware`, exported beside `lockMiddleware` and listed before it in
      `middleware`: for a request whose method is not `GET` or `HEAD`, read `Origin`; if absent, or
      the literal `null`, continue — a plain HTML form from this instance sends the origin, and a
      request with none is the shape the framework also lets through; if present and its host is
      not the request URL's host, throw `new Response(null, { status: 400 })`. Compare hosts the way
      the framework does (`new URL(origin).host` against `new URL(request.url).host`), so behind
      the proxy this agrees with the framework's own check on the routes it already covers. Do not
      compare against `PUBLIC_ORIGIN`: the tests address the instance as `http://portfolio.local`
      and the config as `https://portfolio.local`, and a check that reads config would refuse the
      suite's own requests
- [ ] Read `throwIfPotentialCSRFAttack` in `node_modules/react-router/dist/development/chunk-*.mjs`
      before writing this, and cite in the header what it checks, when it runs, and when it is
      skipped — the middleware mirrors it, and says so, rather than inventing a second rule
- [ ] The lock middleware's header paragraph on the forged POST is rewritten to be true: the
      framework's check covers document and single-fetch mutations, this middleware covers the
      rest, and the cookie requirement on the outage carve-out is the third, independent reason
- [ ] `ARCHITECTURE.md` §4.2's single-site table gains the row; §2's trust-boundary table, if it
      names the `Origin` header, says who checks it

**Tests**

- [ ] `tests/routes/root.test.ts`, through `servedThrough` with the new middleware first: a POST
      with `Origin: https://evil.test` to `/lock-now` is refused with 400 and `next` is never
      invoked; a POST with a matching `Origin` continues; a POST with no `Origin` continues; a GET
      with a foreign `Origin` continues; `Origin: null` continues
- [ ] The existing lock-middleware tests are unchanged — they run the lock alone and must keep
      doing so; one test runs the full `middleware` array in order and shows the origin refusal
      wins before the lock is consulted (no database call is made — assert through the unreachable
      database the file already uses for outage tests)

**Verification**

1. `npx vitest run tests/routes/root.test.ts` — real pass count.
2. `npm run typecheck`, `npm run build`, `npm test`.
3. If a dev server is to hand: `curl -X POST -H 'Origin: https://evil.test' -D -
   http://localhost:5173/lock-now` answers 400; the same without the header answers a 302.
