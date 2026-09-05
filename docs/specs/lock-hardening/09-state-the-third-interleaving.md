# 09 — State the third interleaving of the first enrolment, where the migration claims two halves suffice

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F11](../../research/2026-09-05-lock-slice-launch-review.md#fix-later) and on spec 0020's decision
to state it rather than close it._

**What to build:** Corrections to three comments and one ticket box, and no code. Migration 0012
(`migrations/0012_lock.sql:103-134`) and ticket 01 of the lock slice (`docs/specs/lock/01:49-54`)
argue that two mechanisms close the household's first enrolment — the conditional bootstrap insert
(`where not exists`) and the partial unique index on `bootstrap` — and that "neither is enough
alone". The review found the interleaving they leave open: browser A begins an assertion-authorised
enrolment (`register`, `bootstrap: false`) while the household holds X; X is removed; browser B,
seeing an open household, begins a bootstrap; A's ordinary insert and B's conditional insert
execute together. The index conflicts only flagged rows with each other, B's `not exists` cannot
see A's uncommitted tuple, and both land — B holding an assertion-free passkey in a household A
has just locked. Reproduced at the SQL level with the module's own statements.

Its own ticket because the sentence it corrects sits in a migration comment — the one place a
wrong argument does the most damage, since the next author takes it for the whole rule — and
because two ways to close the window were considered and rejected, and the reasons belong beside
the claim.

**Blocked by:** [04](04-narrow-what-registration-stores.md), which edits `completeRegistration`'s
header.

**Status:** ready-for-agent

**What is true, and where to say it**

- [ ] `migrations/0012_lock.sql`, the comment above `passkey_bootstrap_idx`: the two halves close
      two interleavings — a passkey committed before the bootstrap insert runs (the conditional
      insert), and two bootstrap inserts in flight together (the index) — and leave a third open: a
      bootstrap insert in flight together with an *ordinary* insert whose own snapshot still saw the
      passkey that authorised it. Under autocommit that window is one statement wide, and reaching
      it takes a gate-admitted family member holding a `register` challenge minted while the
      household was locked, completed inside the two minutes it lives, across the instant every
      passkey is removed and another browser bootstraps. Say what the pair guarantees — at most one
      flagged live row, and no bootstrap into a household that already holds a committed passkey —
      and that it does not serialise an ordinary insert against a bootstrap one
- [ ] The same comment names the two ways to close it and why neither is taken: a mirror predicate
      on the ordinary insert (`where exists (select 1 from passkey)`) narrows the window to the
      ordinary statement's own duration but does not close it — A's snapshot can predate X's
      removal while B's follows it — and it refuses the case `app/lib/lock.server.ts:1108-1115`
      names as fine (A completing after every passkey was removed), leaving a credential orphaned
      in A's vault; a `lock table passkey in share row exclusive mode` before the bootstrap insert
      closes it, but only inside an explicit transaction, which this module deliberately does not
      open (`guardedAgainstConstraintViolation`'s header, `:1040-1049`) — its writes run on the
      autocommitting handle and savepoints stand in for transactions only where a caller already
      holds one. The decision is spec 0020's; cite it
- [ ] `app/lib/lock.server.ts`, `completeRegistration`'s header (`:1075-1086`): the sentence
      "Neither half is sufficient alone (migration 0012's comment …)" is joined by one saying what
      the pair still leaves open, pointing at the migration comment rather than repeating it
- [ ] `docs/specs/lock/01-the-passkey-and-the-grant.md:49-54`, the box "Only one passkey may be the
      household's first, and it takes **two** mechanisms rather than either one": corrected to say
      what the two close and what they leave, in one added sentence — the box is a record of what
      was built, and it stays true as a record
- [ ] Editing an applied migration's *comment* is safe: `server/migrations.ts` ledgers filenames,
      never contents, so the file's text can change without a new migration. Say so in the commit
      message, since CLAUDE.md's "forward-only" is about schema and a reader may hesitate

**Tests**

- [ ] None. No behaviour changes. The test that would pin the residual would pin a window this
      spec decided to leave; the two existing bootstrap tests, and the two ticket 02 adds, pin what
      the pair does guarantee

**Verification**

1. `grep -n "neither is enough alone\|Neither is enough alone\|Neither half is sufficient alone"
   migrations/0012_lock.sql app/lib/lock.server.ts docs/specs/lock/01-*.md` — each hit sits beside
   the corrected sentence, or is gone.
2. `npm run typecheck`, `npm run build`, `npm test` — unchanged counts (the migration's SQL is
   byte-identical outside comments; `npm run migrate` against a fresh database still applies it).
