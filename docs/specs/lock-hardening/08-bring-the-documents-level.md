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

**Blocked by:** [02](02-pin-the-wiring.md) and [10](10-refuse-a-cross-origin-post.md), which each
rewrite a comment in `app/root.tsx`; [05](05-say-what-the-family-will-see.md) and
[11(a)](11-the-small-ones.md), which edit the guide. Nothing here touches the guide, but branching
after them is what keeps the grep list below true.

**Status:** ready-for-agent

**Documents**

- [ ] `DESIGN.md:837-838`, "Authentication is not multi-user": "the app carries no sign-in page, no
      password and no session of its own" — the third claim is the one ARCHITECTURE.md and
      README.md already corrected. Say what the grant is in the words ADR-0012 uses (one browser,
      one moment, no identity) and leave the paragraph's argument standing
- [ ] The "credential" collision: `CONTEXT.md:150-151` now defines a passkey as "a credential", and
      four places say the grant cookie "carries a credential" — `docs/adr/0002:55` ("the app's own
      grant cookie … is a credential too"), `docs/adr/0012:120`, `DESIGN.md:1065-1067` and
      `app/lib/lock.server.ts:191`. Under the glossary's own rule those now read "carries a
      passkey", the opposite of the truth. Say what the cookie carries — an opaque id, a bearer of
      one browser's unlock — in all four; leave the glossary as #240 left it
- [ ] The flat fifteen: `app/lib/reentry.ts:22` and `:86` ("rides out its own fifteen-minute idle
      window", "the ordinary fifteen-minute idle window") and `docs/specs/0019-the-lock.md:123`
      ("**fifteen minutes**, extended by the requests that use it"). The effective window is
      7.5–15 minutes because `touchGrant` rolls only under half a window; say "at most fifteen
      minutes from the last request that rolled it" or the range, whichever the sentence needs
- [ ] `docs/specs/lock/07-documents-and-the-limit.md:117-118` requires `scripts/seed-demo.ts` to
      seed a passkey; the merged scripts do the opposite on purpose (`seed-demo.ts:23-32` stays
      unlocked; `capture-screenshots.ts:224-285` plants the passkey, mints the grant and sets the
      cookie). Correct the box to describe what shipped and why. `docs/specs/lock/06:72-77` only
      defers the capture to 07 and describes the scripts as they then were — one sentence there,
      not a rewrite
- [ ] `ARCHITECTURE.md:690` cites `people.server.ts:278` for the person delete; `removePerson` is
      at `app/lib/people.server.ts:211`. Cite the function by name
- [ ] `docs/operating.md:581`, the bold-led paragraph on session handling under "What the code
      still does not do": "There is no server-side session store, so there is nothing to revoke a
      single cookie against" is true of the gate and now sits above a section describing a
      per-browser store revocable one row at a time. Scope the sentence to the gate in its own
      words
- [ ] `docs/operating.md` and `docs/runbook.md`, the recovery: one sentence that every household
      browser still holds a cookie naming a deleted row, that it is inert while no passkey exists,
      and that it is cleared on the first refusal after the next enrolment
- [ ] `docs/adr/0012`: one sentence stating the bearer-token limit the spec, the migration and
      `docs/data-model.md` state — a copied live cookie works until its row ends. (The guide's
      sentence is ticket 05's)

**Comments describing removed behaviour**

- [ ] `app/root.tsx:523`, the loader comment on `hasPasskey` ("the re-entry effect below that gates
      on the same flag") — it does not; say the flag draws the control only
- [ ] `app/root.tsx:751`, the `askServer` doc ("what a hidden-too-long return with no passkey
      believed enrolled does") — that branch is gone; `askServer` is the persisted-restore action
      only
- [ ] `app/root.tsx:733-745`, the `attemptLock` doc's paragraph arguing a sibling tab must never
      delete the enrolling browser's grant — the hidden-too-long return does exactly that by design
      (spec 0019 "What re-locks it", story 3); rewrite it to say which trigger is declined (a tab
      *discovering* a passkey) and which is not (a return after the grace)
- [ ] `app/components/lock-now-control.tsx:9-10`: `rootData.locked` is `hasPasskey`, and the
      re-entry guard no longer gates on it
- [ ] `app/lib/reentry.ts:155-164`, `postLockNow`'s header: `response.ok` "is the one answer here
      that actually means the grant is gone" — any 2xx satisfies it (a captive portal's page, the
      gate's sign-in page if the provider button were not skipped). Say it is the best signal a
      fetch has, and what it does not prove
- [ ] `app/lib/reentry.ts:245-253`, the comment on seeding `hiddenAt` from the mount state: it
      already names "opened in a background tab"; extend it with the decision (spec 0020: kept, it
      fails toward locking) and the cost (one prompt on the first look at a tab opened without
      switching to it). No twin paragraph in the module header
- [ ] `tests/reentry.test.ts`'s prose and dead assertions are ticket 02's, not this one's

**The one decision to record**

- [ ] `app/root.tsx:361-364`, `lockMiddleware`'s header, the paragraph on what the lock does not
      cover: "exempting `/healthz` also exempts its single-fetch (`.data`) form, which is harmless:
      that route holds no household data either way" is wrong about *why*. The root loader runs
      too and serialises the shell's setup state (`gated`, `firstRun`, `masked`, `maskingPolicy`,
      `hasPasskey`) for a browser holding no grant; the owner decided on 2026-09-05 to keep it,
      because the request sits behind the gate and the fields are setup state, never a figure.
      Write that — the fact, the decision and its reason — so the next reader does not "fix" it

**Not this ticket's**

- [ ] `app/root.tsx:262-270`'s claim that the framework's `Origin` check runs before this
      middleware "for every mutation method" is ticket 10's to make true, not this one's to soften

**Verification**

1. Each quoted phrase above, grepped across the repository, returns nothing; the pull request body
   lists the greps.
2. `npm run typecheck`, `npm run build`, `npm test` — unchanged counts.
