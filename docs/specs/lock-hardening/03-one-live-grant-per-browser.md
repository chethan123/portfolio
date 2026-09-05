# 03 — One live grant per browser

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F4](../../research/2026-09-05-lock-slice-launch-review.md#f4--should-fix--lock-now-leaves-a-browsers-earlier-grants-live)._

**What to build:** When a request that already carries a live grant verifies a new assertion —
the confirm-with-an-existing-passkey step of an enrolment, a removal, or an unlock posted by a
browser whose cookie is still live — the grant it carried is deleted in the same call that mints
the new one. Today every verified assertion mints a row and the route replaces the cookie; the
previous row stays live for the rest of its window, "Lock now" deletes only the one the cookie
names, and the review observed a browser holding two live rows after one enrolment confirm. A
copied older cookie therefore survives the explicit control the guide tells a family member to
press before handing over a phone.

Its own ticket because it is one lifecycle rule in the domain module with a small change to each
of three callers, and because the removal route's cookie decision gets simpler rather than more
elaborate once a browser can hold at most one live row.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The rule, in the domain module**

- [ ] `verifyUnlock`, `beginEnrolment` and `removePasskey` each take one more optional input —
      the grant id this request's cookie names, `supersedes?: string` — and pass it to
      `verifyScopedAssertion`, which passes it to `mintGrant`. Nothing else learns the cookie's
      value; the routes read it with `readLockCookie` as they already do and hand it down
- [ ] `mintGrant` deletes the superseded row and inserts the new one. A `supersedes` that names
      nothing (a stale cookie) deletes nothing and is not an error. The two statements run in the
      order delete-then-insert so a failure between them leaves the browser with no live grant
      rather than two — the direction every other failure in this module already takes
- [ ] The module header's paragraph on "every verified assertion mints one" gains the sentence
      that a browser therefore holds at most one live grant at a time, and the rule that
      `supersedes` must come from the request's own cookie and never from a form field
- [ ] `removePasskey`'s route logic in `app/routes/settings/passkeys.tsx` (the block that re-reads
      `readGrant(grant.id)` and falls back to the prior cookie) is reduced to what is still true: if
      the minted grant survived the cascade, set its cookie; otherwise the prior grant is already
      gone too (it was superseded), so clear the cookie. The `priorGrantId` re-read goes; the
      header paragraph describing it is rewritten to describe the new shape
- [ ] `beginEnrolment`'s route call passes the cookie's id; `verifyUnlock`'s does too — the unlock
      loader already bounces a browser holding a live grant, but the action can still be posted
      with one, and that post must not leave two rows

**Tests**

- [ ] `tests/lock.test.ts`: after an unlock (g1), an enrolment confirm carrying g1 (g2) and a
      removal of another passkey carrying g2 (g3), exactly one live row exists for that browser's
      passkey and it is g3; `deleteGrant(g3)` then leaves zero
- [ ] `tests/routes/lock-now.test.ts`'s "a request carrying the old cookie is refused" is extended
      to the *older* cookies: g1 and g2 are refused by the middleware after the sequence above,
      before any Lock now
- [ ] A `supersedes` naming a grant that does not exist mints normally
- [ ] `tests/routes/settings-passkeys.test.ts`'s removal cookie matrix is rewritten for the new
      shape — signer is the target (cookie cleared), signer is not the target (cookie is the fresh
      grant) — and the states that no longer exist are deleted, not left asserting a fallback
      nothing reaches
- [ ] The review's drive, step S11, is the manual check: after the confirm step, `unlock_grant`
      counts 1, not 2

**Verification**

1. `npx vitest run tests/lock.test.ts tests/routes/lock-now.test.ts
   tests/routes/settings-passkeys.test.ts` — real pass counts, the new `it`s among them.
2. The first new test must fail on the parent commit (three live rows) — confirm before the change.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. The drive script under `docs/research/2026-09-05-lock-slice-launch-review/harness/`, step S11's
   count, if a browser is to hand.
