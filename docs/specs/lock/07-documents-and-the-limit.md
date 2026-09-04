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

- [ ] `ARCHITECTURE.md`'s Appendix A says there is no authentication module and that its absence is
      the design, telling a contributor looking for one to stop. Corrected to name the module and say
      what it does and does not decide — a grant names a browser, never a person
- [ ] `react-router.config.ts`'s comment on the middleware flag says auth is not a reason for it,
      because authentication happens in front of the app. It now also carries a lock
- [ ] `ADR-0002`'s stated limit — *"The login gate (§10) is the only boundary this application has,
      and anyone who can reach a masked screen can unmask it with one click"* — is amended in place,
      in the bracketed form it already carries from when ADR-0005 moved the gate. The argument stays
      where it was made and what changed is stated beside it, pointing at ADR-0012
- [ ] `app/root.tsx`'s comment about nothing replacing the gate as root middleware is ticket 03's to
      fix, not this one's; check it was done

**DESIGN.md**

- [ ] §10's summary gains the lock as a thing that exists, distinct from the gate above it
- [ ] §10.1's environment table gains `PUBLIC_ORIGIN`, and the sentence saying the gate's settings are
      absent because the app never reads them is corrected to name the one both services read
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
- [ ] §7.6's trust-boundary table gains the grant cookie: not trusted, an opaque id, the row is the
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
