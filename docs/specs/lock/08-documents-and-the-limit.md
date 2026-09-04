# 08 — Every document level, and the limit said out loud

_Part of [0019-the-lock.md](../0019-the-lock.md)._

**What to build:** The documents brought level with what now exists. ADR-0002 amended where it is now
false, DESIGN.md given the lock in its architecture summary and the honest limitation in §14,
ARCHITECTURE.md given the middleware and the two tables, and the specs index updated.

Its own ticket because a slice that changes what the instance's boundary *is* leaves several documents
asserting the old boundary, and fixing them inside a feature pull request buries the change nobody
should miss.

**Blocked by:** every other ticket in this slice.

**Status:** ready-for-agent

**ADR-0002**

- [ ] Its stated limit says the gate is the only thing that keeps anyone out. That is now false, and it
      is amended in place, in the bracketed form it already carries from when ADR-0005 moved the gate —
      the argument stays where it was made and what changed is stated beside it
- [ ] The amendment says what masking still guarantees and what it never did, and points at ADR-0012
- [ ] Nothing else in that ADR changes; masking's own behaviour did not

**DESIGN.md**

- [ ] §10's summary gains the lock as a thing that exists, distinct from the gate above it
- [ ] §14 gains a numbered limitation in the voice of the sign-out entry: once the household holds a
      passkey, a browser that cannot run the ceremony cannot read this instance, and the recovery is
      the operator's rather than the front door's
- [ ] A second limitation states the platform's honest ceiling — the check is not necessarily a
      biometric, carries no freshness, and a synced passkey is only as strong as whatever unlocks its
      provider on that device
- [ ] The section that says authentication is not multi-user still holds and is left alone: a grant
      names a browser, never a person, and nothing here decides what anyone may see

**ARCHITECTURE.md**

- [ ] The middleware is named as the single site enforcing the lock, in §4.2's form, so a later grep
      finds the rule rather than the exception
- [ ] Appendix A gains the domain module and the two tables
- [ ] The trust-boundary table gains the grant cookie: not trusted, an opaque id, the row is the
      authority

**The indexes**

- [ ] `docs/specs/README.md` gains 0019 in the slices table and `lock/` in the ticket directories
      paragraph
- [ ] The ADR is referenced by number from the spec and from `CONTEXT.md`'s entries where it earns it

**What is deliberately not written**

- [ ] No glossary entry for the grant. `CONTEXT.md` adds a term when one is resolved, and the grant is
      implementation the household never names — `Locked` and `Passkey` are the words it has
- [ ] No count of tickets, screens or tables anywhere: state the rule, not the number
