# 09 — Close the third interleaving of the first enrolment

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F11](../../research/2026-09-05-lock-slice-launch-review.md#fix-later)._

**What to build:** A condition on the *non-bootstrap* insert in `completeRegistration`
(`app/lib/lock.server.ts`) so that a registration authorised by an assertion lands only into a
household that still holds a passkey. Migration 0012 and ticket 01 of the lock slice argue that
two mechanisms close the first enrolment — the conditional bootstrap insert (`where not exists`)
and the partial unique index on `bootstrap` — and that "neither is enough alone". The review found
the interleaving they leave open: browser A begins an assertion-authorised enrolment
(`bootstrap: false`); every passkey is removed; browser B, seeing an open household, begins a
bootstrap; A's plain insert and B's conditional insert execute together. The index conflicts only
flagged rows with each other, B's `not exists` cannot see A's uncommitted tuple, and both land — B
holding an assertion-free passkey in a household A has just locked. Reproduced at the SQL level
with the module's own statements.

Its own ticket because it changes one statement's predicate and the argument in two documents, and
because the test that proves it is a two-connection race that deserves a reviewer's whole
attention.

**Blocked by:** [02](02-pin-the-wiring.md), whose bootstrap-race tests this extends.

**Status:** ready-for-agent

**The change**

- [ ] The non-bootstrap insert becomes `insert into passkey (…) select … where exists (select 1 from
      passkey)` — the mirror of the bootstrap half. A registration that was authorised by an
      assertion against a household that has since emptied writes nothing and refuses with its own
      sentence: every passkey was removed while this one was being created, the household is open
      again, start again from Settings, which needs no confirmation now
- [ ] Why this closes the race, stated in the migration's comment and the function's header, in
      the terms the migration already uses: under READ COMMITTED each statement sees the committed
      rows at its own start. For both inserts to land, A's `exists` must see a committed row and
      B's `not exists` must see none; with only A and B in flight that is impossible in the same
      instant, so at most one lands. The sequential case that still lands both — B's bootstrap
      commits, then A's assertion-authorised row joins it — is by design: A proved possession of a
      passkey the household held within the challenge's two minutes
- [ ] The argument was run before this ticket was written, on PostgreSQL 16.13 with two
      connections and the two statements above: ordinary insert first and left uncommitted, then
      bootstrap → 0 and 1 rows; bootstrap first and left uncommitted, then ordinary → 1 and 0;
      bootstrap committed, then ordinary → 2. The test below is that experiment made durable
- [ ] The migration's "two halves" comment is corrected to name three: the conditional bootstrap
      insert, the conditional ordinary insert, and the index — and to say which pair closes which
      interleaving. Ticket 01 of the lock slice (`docs/specs/lock/01-*.md`) gets the same
      correction in its box
- [ ] Nothing changes for the ordinary case: a locked household enrolling a second passkey still
      lands, and `DUPLICATE_PASSKEY_MESSAGE` still comes from the primary key

**Tests**

- [ ] `tests/lock-schema.test.ts` (or `tests/lock.test.ts`, where the fixture is): the race the
      review reproduced, with two connections — A's plain insert issued and left uncommitted, B's
      bootstrap insert issued — asserts exactly one row lands whichever commits first, in both
      orders
- [ ] The sequential case: B bootstraps and commits; A's plain insert then lands beside it
      (`bootstrap = false`), and the household holds two
- [ ] The refusal: a `register` challenge with `bootstrap: false` completed against an empty table
      answers the new sentence and writes nothing
- [ ] Ticket 02's two bootstrap tests still pass unchanged

**Verification**

1. `npx vitest run tests/lock.test.ts tests/lock-schema.test.ts` — real pass counts.
2. The race test must fail on the parent commit (two rows) — confirm before the change; the
   review's SQL-level reproduction is the shape to copy.
3. `npm run typecheck`, `npm run build`, `npm test`.
