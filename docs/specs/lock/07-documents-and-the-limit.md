# 07 — Every document level, and the limit said out loud

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The documents brought level with what now exists. Several of them assert, in as
many words, that this application has no authentication code and no boundary of its own. Those
sentences were true when they were written and are the first thing a contributor reads.

Its own ticket because a slice that changes what the instance's boundary *is* leaves those statements
standing, and fixing them inside a feature pull request buries the change nobody should miss.

**Blocked by:** [01](01-the-passkey-and-the-grant.md), [02](02-the-two-ceremonies.md),
[03](03-the-middleware-that-refuses.md), [04](04-the-unlock-screen.md),
[05](05-enrolling-and-listing-passkeys.md), [06](06-lock-now-and-coming-back.md).

**Status:** ready-for-agent

**The sentences this slice falsifies**

This list is the ticket. Each is a claim some document makes in as many words, true when written, and
false the moment this slice lands. Grep for the quoted phrase rather than trusting the line number.

- [ ] `ARCHITECTURE.md` — *"There is no authentication middleware and no open list in the app"*. This
      slice adds both. It is the property most directly reversed and the sentence a reviewer will
      quote back
- [ ] `ARCHITECTURE.md` — *"The app authenticates nobody: it carries no password, no login route and
      no session of its own"*. Still true of passwords and logins, false about the third. Correct it
      by saying what the grant is rather than by calling it a session: one browser, one moment, no
      identity — the sense in which ADR-0012 says a grant is not a session is the sense this sentence
      meant when it said the app has none
- [ ] `ARCHITECTURE.md`, `compose.yaml` and `docs/operating.md` each say some version of *"with the
      app carrying no cookie of its own, the gate's `SameSite` **is** the CSRF posture"*. The
      app now issues one. The posture survives — the grant cookie is `Lax` too — but the reason given
      for it no longer holds, and three files state it
- [ ] `ARCHITECTURE.md` — *"The `Caddyfile` is the single list of exemptions in the deployment"* — and
      `app/routes/healthz.ts` — *"its Caddyfile is the only list of such exemptions"*. Ticket 03 adds a
      second list and a test that enumerates it
- [ ] `ARCHITECTURE.md`'s Appendix A says there is no authentication module and that its absence is
      the design, telling a contributor looking for one to stop. Corrected to name the module and say
      what it does and does not decide — a grant names a browser, never a person
- [ ] `ADR-0002`'s stated limit — *"The login gate (§10) is the only boundary this application has,
      and anyone who can reach a masked screen can unmask it with one click"* — amended in place, in
      the bracketed form it already carries from when ADR-0005 moved the gate, pointing at ADR-0012
- [ ] `ADR-0002` again, further down — *"the only session cookie anywhere is the gate's, which the app
      never issues"*. Amending the first sentence and leaving this one is how a document ends up
      arguing with itself
- [ ] `README.md` — *"The app therefore has no password, no login page and no session cookie of its
      own, and it makes no authorization decision at all"*. The longest and most-read document in the
      repository, carrying the same claim as the two ADR sentences above it
- [ ] `CLAUDE.md` — *"The only deletes in the app are two narrow cases … plus `upload_draft`
      scaffolding rows"*. This slice adds three delete paths, and `CLAUDE.md` is the file an agent
      reads first
- [ ] `react-router.config.ts`'s comment on the middleware flag says auth is not a reason for it,
      because authentication happens in front of the app. It now also carries a lock
- [ ] `app/root.tsx`'s comment about nothing replacing the gate as root middleware is ticket 03's to
      fix, and DESIGN.md §10.1's environment table is ticket 02's; check both were done rather than
      doing them twice

**DESIGN.md**

- [ ] §10's summary gains the lock as a thing that exists, distinct from the gate above it
- [ ] §14 gains a limitation in the voice of the sign-out entry: once the household holds a passkey, a
      browser that cannot run the ceremony cannot read this instance, and the recovery is the
      operator's rather than the front door's
- [ ] A second states the platform's ceiling — the check is not necessarily a biometric, carries no
      freshness, and a synced passkey is only as strong as whatever unlocks its provider on that
      device
- [ ] The section saying authentication is not multi-user still holds and is left alone

**ARCHITECTURE.md**

- [ ] The root middleware is named as the single site enforcing the lock, in §4.2's form, so a later
      grep finds the rule rather than the exception
- [ ] Appendix A gains the domain module and the two tables
- [ ] The trust-boundary table — the `Boundary | Crossing | Trusted?` one in §2, not §7.6's
      `Control | State` table — gains the grant cookie: not trusted, a random id, the row is the
      authority

**The schema authority**

- [ ] `docs/data-model.md` explains every table and column, its relationships and its invariants, for
      somebody holding a dump. It gains `passkey` and `unlock_grant` in the same form as the rest: the
      columns, the cascade, the expiry and its index, and that both are scaffolding which may be
      deleted from where the other tables may not

**The family guide**

- [ ] `docs/guide/settings.md` hard-codes the tab strip and says, in bold, that nothing in this
      application deletes anything. Both become false: there is a Passkeys tab, and it removes
- [ ] `docs/guide/first-run.md` tells the reader that masking is not a lock and the sign-in is the
      only thing that keeps anyone out. There is a lock now, and this is the family's own document
- [ ] The guide gains the Passkeys screen and what unlocking is, in the family's words rather than
      the specification's

**The operator's documents, which are two and not one**

- [ ] `docs/operating.md` gains the explanations: the first run and what enrolling the first passkey
      does to every other browser, the recovery when every passkey is unreachable, and that the `app`
      service will not start without `PUBLIC_ORIGIN`
- [ ] `docs/runbook.md` gains the symptoms and the commands, because that is the document read at 2am
      and where somebody locked out of every credential will look. It confirms, acts, and links to
      `docs/operating.md` for the why — it explains nothing itself, which is the seam that keeps the
      two from drifting
- [ ] The recovery is that the operator deletes the passkeys, which returns the instance to unlocked
      and lets anyone the gate admits enrol again. There is deliberately no token, no second path and
      no way in through the front door

**The pictures**

- [ ] The committed screenshots are retaken with `scripts/capture-screenshots.ts`. Ticket 04 retakes its
      own (the unlock screen); ticket 05, on its own branch, already retook its own — the Settings tab
      strip shots — because that screen renders with no passkey enrolled. Ticket 06 defers its
      screenshots to this ticket's single capture pass rather than retaking them itself, and this ticket
      is what has to own that capture, not merely check for it: the capture path seeds no passkey today,
      so `isLocked()` is false throughout and the lock-now control cannot render in either chrome
      position, in any shot, no matter how the rest of the set is retaken. Closing that gap is this
      ticket's own work — `scripts/seed-demo.ts` must seed one passkey, and
      `scripts/capture-screenshots.ts` must mint a grant against it and set the `__Host-unlock_grant`
      cookie on the capture browser — one change to the two scripts serving this ticket's own shots of
      the control, rather than a third ticket fighting tickets 05 and 06 over the same PNGs. With that
      done, this ticket checks the whole set, ticket 06's control included — `docs/README.md` and
      `docs/developing.md` both say a change to a screen is not finished until they are, and this slice
      changes the chrome, adds a Settings tab and adds a screen

**What is deliberately not written**

- [ ] No glossary entry for the grant. `CONTEXT.md` adds a term when one is resolved, and the grant is
      implementation the household never names — `Locked` and `Passkey` are the words it has
- [ ] No count of tickets, screens or tables anywhere: state the rule, not the number
