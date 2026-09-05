# 08 — Bring every other document and comment level with the code

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F8](../../research/2026-09-05-lock-slice-launch-review.md#f8--should-fix--documents-that-state-things-the-code-does-not-do)
items 5 and 7–13, and its §3 notes._

**What to build:** Every sentence and comment the review found describing something the merged
code does not do, corrected in place — and one comment corrected to record a decision the owner
took after the review. No behaviour changes. Grep for each quoted phrase rather than trusting a
line number; the review was written against `1ffdc6e` and the tree has moved.

Its own ticket for the reason ticket 07 of the lock slice was: a document that argues with itself
is the first thing a contributor reads, and fixing it inside a behaviour change buries it.

**Blocked by:** [05](05-say-what-the-family-will-see.md) and [07](07-hedge-cross-device-and-walk-it.md),
which edit the guide; and [10](10-refuse-a-cross-origin-post.md), which rewrites the one comment
below that becomes *true* rather than corrected.

**Status:** ready-for-agent

**Documents**

- [ ] `DESIGN.md`, "Authentication is not multi-user": "the app carries no sign-in page, no
      password and no session of its own" — the third claim is the one ARCHITECTURE.md and
      README.md already corrected. Say what the grant is in the words ADR-0012 uses (one browser,
      one moment, no identity) and leave the paragraph's argument standing
- [ ] The "credential" collision: `CONTEXT.md` now defines a passkey as "a credential", and four
      places say the grant cookie "carries a credential" — `docs/adr/0002` ("the app's own grant
      cookie … is a credential too"), `docs/adr/0012` ("this one carries a credential"), `DESIGN.md`
      (the cookie table row) and `app/lib/lock.server.ts`'s comment on `LOCK_COOKIE`. Under the
      glossary's own rule those now read "carries a passkey", the opposite of the truth. Say what
      the cookie carries — an opaque id, a bearer of one browser's unlock — in all four; leave the
      glossary as #240 left it
- [ ] The flat fifteen: `app/lib/reentry.ts` (two places: "rides out its own fifteen-minute idle
      window", "the ordinary fifteen-minute idle window") and `docs/specs/0019-the-lock.md`
      ("**fifteen minutes**, extended by the requests that use it"). The effective window is
      7.5–15 minutes because `touchGrant` rolls only under half a window; say "at most fifteen
      minutes from the last request that rolled it" or the range, whichever the sentence needs
- [ ] `docs/specs/lock/07-documents-and-the-limit.md` and `docs/specs/lock/06-lock-now-and-coming-back.md`:
      both require `scripts/seed-demo.ts` to seed a passkey; the merged scripts do the opposite on
      purpose (`seed-demo.ts` stays unlocked; `capture-screenshots.ts` plants the passkey, mints the
      grant and sets the cookie). Correct both boxes to describe what shipped and why
- [ ] `ARCHITECTURE.md`'s citation `people.server.ts:278` for the person delete points at nothing;
      `removePerson` is the function — cite it by name, or by a line that is checked when written
- [ ] `docs/operating.md`, "Session handling": "There is no server-side session store, so there is
      nothing to revoke a single cookie against" is true of the gate and sits above a section that
      now describes a per-browser store revocable one row at a time. Scope the sentence to the gate
      in its own words
- [ ] `docs/operating.md` and `docs/runbook.md`, the recovery: one sentence that every household
      browser still holds a cookie naming a deleted row, that it is inert while no passkey exists,
      and that it is cleared on the first refusal after the next enrolment
- [ ] `docs/adr/0012` and `docs/guide/passkeys.md`: neither states the bearer-token limit the spec,
      the migration and `data-model.md` state — a copied live cookie works until its row ends. One
      sentence each, the guide's in the family's words

**Comments describing removed behaviour**

- [ ] `app/root.tsx`, the loader comment on `hasPasskey` ("the re-entry effect below that gates on
      the same flag") — it does not; say the flag draws the control only
- [ ] `app/root.tsx`, the `askServer` doc ("what a hidden-too-long return with no passkey believed
      enrolled does") — that branch is gone; `askServer` is the persisted-restore action only
- [ ] `app/root.tsx`, the `attemptLock` doc's paragraph arguing a sibling tab must never delete the
      enrolling browser's grant — the hidden-too-long return does exactly that by design (spec
      0019 "What re-locks it", story 3); rewrite it to say which trigger is declined (a tab
      *discovering* a passkey) and which is not (a return after the grace)
- [ ] `app/components/lock-now-control.tsx`'s header: `rootData.locked` is `hasPasskey`, and the
      re-entry guard no longer gates on it
- [ ] `tests/reentry.test.ts`'s header and its "What moved here" paragraph describe an
      `assumedPasskey` parameter and a `resolveReentryCallback` that no longer exist; the two
      `expect(askServer).not.toHaveBeenCalled()` assertions test a function never handed to
      `watchReentry` — delete the assertions and rewrite the prose
- [ ] `app/lib/reentry.ts`, `postLockNow`'s header: `response.ok` "is the one answer here that
      actually means the grant is gone" — any 2xx satisfies it (a captive portal's page, the gate's
      sign-in page if the provider button were not skipped). Say it is the best signal a fetch has,
      and what it does not prove
- [ ] `app/lib/reentry.ts`, the module header: a tab hydrated hidden counts as hidden from that
      moment, by decision (0020's "Decisions already taken"), with the Cmd-click case named

**The one decision to record**

- [ ] `app/root.tsx`, `lockMiddleware`'s header, the paragraph on what the lock does not cover:
      "exempting `/healthz` also exempts its single-fetch (`.data`) form, which is harmless: that
      route holds no household data either way" is wrong about *why*. The root loader runs too and
      serialises the shell's setup state (`gated`, `firstRun`, `masked`, `maskingPolicy`,
      `hasPasskey`) for a browser holding no grant; the owner decided on 2026-09-05 to keep it,
      because the request sits behind the gate and the fields are setup state, never a figure.
      Write that — the fact, the decision and its reason — so the next reader does not "fix" it

**Not this ticket's**

- [ ] `app/root.tsx`'s comment claiming the framework's `Origin` check runs before this middleware
      "for every mutation method" is ticket 10's to make true, not this one's to soften

**Verification**

1. Each quoted phrase above, grepped across the repository, returns nothing; the pull request body
   lists the greps.
2. `npm run typecheck`, `npm run build`, `npm test` — unchanged counts.
