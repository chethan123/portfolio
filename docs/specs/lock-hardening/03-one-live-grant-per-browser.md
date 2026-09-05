# 03 — One live grant per browser

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F4](../../research/2026-09-05-lock-slice-launch-review.md#f4--should-fix--lock-now-leaves-a-browsers-earlier-grants-live)._

**What to build:** When a request that already carries a live grant verifies a new assertion —
the confirm-with-an-existing-passkey step of an enrolment, a removal, or an unlock posted by a
browser whose cookie is still live — the grant it carried is deleted in the same call that mints
the new one, with one exception the removal screen's own promise requires. Today every verified
assertion mints a row and the route replaces the cookie; the previous row stays live for the rest
of its window, "Lock now" deletes only the one the cookie names, and the review observed a browser
holding two live rows after one enrolment confirm. A copied older cookie therefore survives the
explicit control the guide tells a family member to press before handing over a phone.

Its own ticket because it is one lifecycle rule in the domain module with a one-line change to
each of three callers, and because the exception is the kind of thing a reviewer should see argued
alone.

**Blocked by:** Nothing. Ticket 06 waits for this one (adjacent lines in `verifyScopedAssertion`).

**Status:** ready-for-agent

**The rule, in the domain module**

- [ ] `verifyUnlock` (`app/lib/lock.server.ts:863`), `beginEnrolment` (`:984`) and `removePasskey`
      (`:1240`) each take one more optional input — the grant id this request's cookie names,
      `supersedes?: string` — and pass it to `verifyScopedAssertion` (`:795`), which passes it to
      `mintGrant` (`:312`). Nothing else learns the cookie's value; the routes read it with
      `readLockCookie` as they already do and hand it down. `completeRegistration`'s own mint
      (`:1183`) is the bootstrap case, where no live grant can exist, and is left alone
- [ ] `mintGrant` deletes the superseded row and inserts the new one, delete first, so a failure
      between them leaves the browser with no live grant rather than two — the direction every
      other failure in this module already takes. A `supersedes` that names nothing (a stale
      cookie) deletes nothing and is not an error
- [ ] **The exception.** In `verifyScopedAssertion`, when the scope is a removal and the passkey
      that signed is the very one being removed, the prior grant is *not* superseded. The minted
      grant is about to be cascaded away with its passkey; if the prior grant were deleted too, a
      browser unlocked under passkey M whose removal of T was signed by T (a synced vault's own
      choice, which ADR-0012 allows) would end with zero live rows — and the screen has just told
      it, in the `safeElsewhere` warning (`app/routes/settings/passkeys.tsx:400-403`), that it
      "stays unlocked afterwards". Keeping the prior in that one case keeps the promise, and still
      leaves exactly one live row: the prior survives, the minted one is cascaded. One condition,
      with this paragraph as its comment
- [ ] The module header's paragraph on "every verified assertion mints one" gains the sentence
      that a browser therefore holds at most one live grant at a time, the exception, and the rule
      that `supersedes` must come from the request's own cookie and never from a form field
- [ ] The routes: `app/routes/unlock.tsx`'s action, `passkeys.tsx`'s `beginEnrolment` and `remove`
      branches each pass `readLockCookie(request)`. The `remove` branch's existing cookie decision
      — re-read the minted grant; if it survived set it, else fall back to the prior cookie's grant
      if live, else clear (`passkeys.tsx:286-301`) — is already correct for both outcomes the rule
      now produces (signer is not the target: the prior is gone and the minted one is set; signer
      is the target: the minted one is gone and the prior is kept) and is left as it is. Its header
      paragraph gains one sentence saying which of the two the rule made impossible: a live prior
      *and* a live minted grant at once

**Tests**

- [ ] `tests/lock.test.ts`: after an unlock (g1), an enrolment confirm carrying g1 (g2) and a
      removal of another passkey carrying g2 (g3), exactly one live row exists for that browser and
      it is g3; `readGrant(g1)` and `readGrant(g2)` are undefined. This is the test that fails on
      the parent (three live rows)
- [ ] The exception: a browser unlocked under M removes T with an assertion signed by T, carrying
      M's grant — M's grant is still live afterwards, and the household's live rows for that
      browser number one. This is the state `tests/routes/settings-passkeys.test.ts:1291-1334`
      ("finding 1a") already pins from the route's side; that test stays and must keep passing
- [ ] A `supersedes` naming a grant that does not exist mints normally
- [ ] The unlock action posted with a live cookie leaves one live row, the new one

**Verification**

1. `npx vitest run tests/lock.test.ts tests/routes/lock-now.test.ts
   tests/routes/settings-passkeys.test.ts tests/routes/unlock.test.ts` — real pass counts, the new
   `it`s among them, the finding-1a test still among them.
2. The first new test must fail on the parent commit — confirm before the change.
3. `npm run typecheck`, `npm run build`, `npm test`.
4. The drive script under `docs/research/2026-09-05-lock-slice-launch-review/harness/`, step S11's
   count, if a browser is to hand: `unlock_grant` 1 after the confirm step, not 2.
