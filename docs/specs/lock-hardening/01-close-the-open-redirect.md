# 01 — Close the open redirect on the unlock screen

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F1](../../research/2026-09-05-lock-slice-launch-review.md#f1--should-fix--the-unlock-screens-return-path-is-an-open-redirect)._

**What to build:** One change to `safeReturn` in `app/lib/return-path.ts` so that a `redirectTo`
value which resolves to this origin but *serialises* as a scheme-relative URL is refused. Today
`new URL("/..//evil.test", BASE)` has the right origin and a pathname of `//evil.test`; the
function returns that pathname, `redirect()` hands it to the browser, and the browser goes to
`https://evil.test/`. The unlock screen's loader and action both read the parameter through this
function, so a family member sent `/unlock?redirectTo=/..//evil.test` is redirected off-site the
moment the passkey ceremony succeeds. `/masking` and `/refresh` share the function and the bug.

Its own ticket because it is one function, one rule, and the moment of authentication; nothing
else in this slice touches return paths.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The rule**

- [ ] `safeReturn` keeps its shape — resolve against the throwaway base, demand the origin back —
      and adds one more check on what it is about to *return*: the string it returns must itself
      resolve, against the same base, to the same origin. `new URL("//evil.test", BASE).origin` is
      `http://evil.test`, so this refuses every spelling the review lists, and refuses it by asking
      the parser rather than by pattern-matching a leading `//`
- [ ] The refusal is the existing one: return `"/"`. No new message, no logging — a mangled return
      path is not an event a family member needs told about
- [ ] A normal path with a query survives unchanged: `/holdings?group=account&sort=value` still
      round-trips byte for byte (the existing test in `tests/refresh-control.test.ts` says so)
- [ ] The module header gains two sentences on why the second check exists — the parser collapses
      a leading `..` before it appends the next empty segment, so the origin check alone passes a
      pathname that begins with `//` — beside the existing paragraph on `/\evil.test`

**Tests**

- [ ] In the file that already tests `safeReturn` (`tests/refresh-control.test.ts`, or a new
      `tests/return-path.test.ts` if the existing file's name no longer fits what it holds — say
      which and why in the commit): `/..//evil.test`, `/%2e%2e//evil.test`, `/.//evil.test`,
      `/a/..//evil.test` and `/..\/evil.test` each return `"/"`; `//evil.test` and `/\evil.test`
      still do; `/holdings?x=1` still returns itself
- [ ] `tests/routes/unlock.test.ts`: the action, handed a verifying assertion and
      `redirectTo=/..//evil.test`, redirects to `/`; the loader, on an open household or a browser
      already holding a live grant, does the same — the two places the review shows the redirect
      firing
- [ ] Each `it` is a sentence stating the rule, not the input

**Verification**

1. `npx vitest run tests/refresh-control.test.ts tests/routes/unlock.test.ts` — confirm a real pass
   count, and that the new `it`s appear in it (a `-t` filter that matches nothing exits 0).
2. Before the change, run the same files and confirm the new tests are red — the review reproduced
   the bug with a one-line Node script; the tests must fail on the parent commit for the same
   reason.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. Optional, if a dev server is to hand: `curl -D - --path-as-is
   'http://localhost:5173/unlock?redirectTo=/..//evil.test'` on an open household answers
   `location: /`, never `//evil.test`.
