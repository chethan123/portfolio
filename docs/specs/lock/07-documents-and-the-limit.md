# 07 — Every document level, and the limit said out loud

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The documents brought level with what now exists. Several of them assert, in as
many words, that this application has no authentication code and no boundary of its own. Those
sentences were true when they were written and are the first thing a contributor reads.

Its own ticket because a slice that changes what the instance's boundary *is* leaves those statements
standing, and fixing them inside a feature pull request buries the change nobody should miss.

**Blocked by:** every other ticket in this slice.

**Status:** ready-for-agent

**The sentences this slice falsifies**

This list is the ticket. Each is a claim some document makes in as many words, true when written, and
false the moment this slice lands. Grep for the quoted phrase rather than trusting the line number.

- [ ] `ARCHITECTURE.md` — *"There is no authentication middleware and no open list in the app"*. This
      slice adds both. It is the property most directly reversed and the sentence a reviewer will
      quote back
- [ ] `ARCHITECTURE.md` — *"The app authenticates nobody: it carries no password, no login route and
      no session of its own"*. Still true of passwords and logins, false about the third
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

**The operator's runbook**

- [ ] `docs/operating.md` gains the first run: enrol the first passkey, and what happens to every
      other browser the moment it lands
- [ ] And the recovery: when every enrolled passkey is unreachable, the operator deletes them, which
      returns the instance to unlocked and lets anyone the gate admits enrol again. There is
      deliberately no token, no second path, and no way in through the front door
- [ ] And the deploy note: the `app` service will not start without `PUBLIC_ORIGIN`

**What is deliberately not written**

- [ ] No glossary entry for the grant. `CONTEXT.md` adds a term when one is resolved, and the grant is
      implementation the household never names — `Locked` and `Passkey` are the words it has
- [ ] No count of tickets, screens or tables anywhere: state the rule, not the number
