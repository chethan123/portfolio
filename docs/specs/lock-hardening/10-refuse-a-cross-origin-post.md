# 10 — Refuse a cross-origin mutation on every route, not only the ones the framework covers

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F8](../../research/2026-09-05-lock-slice-launch-review.md#f8--should-fix--documents-that-state-things-the-code-does-not-do)
item 10 and the bearer-token reviewer's finding under it._

**What to build:** A second root middleware in `app/root.tsx`, ahead of the lock's, that refuses a
mutation request whose `Origin` header is present and does not name this instance's host, with a
400 and no body. React Router 7.18.2 runs its own such check, `throwIfPotentialCSRFAttack`
(`node_modules/react-router/dist/development/chunk-ZA36QIGN.mjs:747-765`), for single-fetch
actions (`:854`) and document requests (`:1419`) — and not for resource routes, which
`handleResourceRequest` (`:1563-1581`) serves without it, and which is what `/lock-now`,
`/masking` and `/refresh` are. The comment in `lockMiddleware` (`app/root.tsx:262-270`) claims the
framework's check runs "before this middleware for every mutation method" and offers it as the
second of two reasons a forged POST cannot clear a grant; on a resource route it is the only
reason that is not there. The consequence is bounded — `SameSite=Lax` withholds the cookie from a
cross-*site* POST, so what is left is a same-site sibling origin forcing a lock — but the claim is
in the code, and the fix is one function.

Its own ticket because it is a new single-site rule (ARCHITECTURE.md §4.2's table gains a row),
and a reviewer should see it alone. A six-line check at the top of `lockMiddleware` would do the
same work; it is its own function because it answers a different question from the lock — who may
*ask*, not which browser may *read* — and the table is where a later reader looks for it.

**Blocked by:** Nothing. Ticket 08 waits for this one.

**Status:** ready-for-agent

**The middleware**

- [ ] `crossOriginMutationMiddleware`, a module-level `const` beside `lockMiddleware` (which is not
      exported either; only the `middleware` array is, `app/root.tsx:422`), listed before it in that
      array. For a request whose method is one of `POST`, `PUT`, `PATCH`, `DELETE` — the
      framework's own `isMutationMethod` set (`chunk-62JRHF6Z.mjs:1345-1350`), so `OPTIONS` and
      `HEAD` are not judged — read `Origin`. Absent: continue (a plain HTML form from this instance
      sends it; a request with none is the shape the framework also lets through). Present: parse
      it; an unparseable value, the literal `null`, or a host that is not the request URL's host →
      `throw new Response(null, { status: 400 })`. Compare hosts the way the framework does
      (`new URL(origin).host` against `new URL(request.url).host`), so behind the proxy this agrees
      with the framework's own check on the routes it already covers. Do not compare against
      `PUBLIC_ORIGIN`: the tests address the instance as `http://portfolio.local`
      (`tests/support/routes.ts:118`) and the config as `https://portfolio.local`
      (`vitest.config.ts:33`), and a check that reads config would refuse the suite's own requests
- [ ] `Origin: null` is *refused*, not admitted: the framework assigns the string `"null"` to its
      domain (`chunk-ZA36QIGN.mjs:751`), finds it unequal to the host and not allowed (`:758-760`),
      and answers 400. This middleware mirrors that, and the header says so, citing the lines —
      it restates the framework's rule for the routes the framework skips, and invents nothing
- [ ] The header also cites where the framework's check runs and where it does not (the four line
      references above), so the next reader can see this is the gap and not a second opinion
- [ ] `lockMiddleware`'s header paragraph on the forged POST (`:251-274`) is rewritten to be true:
      the framework's check covers document and single-fetch mutations, this middleware covers the
      rest, and the cookie requirement on the outage carve-out is the third, independent reason
- [ ] `ARCHITECTURE.md` §4.2's single-site table gains the row

**Tests**

- [ ] `tests/support/routes.ts`'s `post` builder gains an optional `headers` argument (today it
      takes fields and a cookie only, `:128-144`), so a test can send an `Origin`; `get` needs none
- [ ] `tests/routes/root.test.ts`, through `servedThrough` with the exported `middleware` array as
      every existing test there already uses it (`:46`, `:214`, `:233`, …): a POST with
      `Origin: https://evil.test` to `/lock-now` is refused with 400 and `next` is never invoked,
      and no database call is made (run it against the unreachable database the file already uses
      for outage tests, `:277-300` — the refusal must come before `isLocked()`); a POST with a
      matching `Origin` continues to the lock; a POST with no `Origin` continues; a GET with a
      foreign `Origin` continues; `Origin: null` is refused; an unparseable `Origin` is refused
- [ ] The existing lock tests keep running the whole array and keep passing: the builders send no
      `Origin`, so the new middleware continues for every one of them. Say so in the pull request
      body rather than exporting `lockMiddleware` to run it alone

**Verification**

1. `npx vitest run tests/routes/root.test.ts` — real pass count.
2. `npm run typecheck`, `npm run build`, `npm test`.
3. If a dev server is to hand: `curl -X POST -H 'Origin: https://evil.test' -D -
   http://localhost:5173/lock-now` answers 400; the same without the header answers a 302.
