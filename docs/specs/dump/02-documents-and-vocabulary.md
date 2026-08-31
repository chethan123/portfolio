# 02 — Documents and vocabulary

_Part of [0014-scheduled-dump.md](../0014-scheduled-dump.md)._

**What to build:** Nothing that runs. Every document that describes this deployment is brought level
with a stack that now takes dumps, and `CONTEXT.md` gains the pair of terms that keeps the promise
honest — a **dump** is what this host holds, a **backup** is what the operator's tool holds
elsewhere. The split makes roughly fifteen existing sentences wrong by its own definition, so the
rename pass is part of this ticket rather than a follow-up.

Separately from [01](01-the-dump-sidecar.md) because a prose diff across nine files is reviewed by
reading, and a container is reviewed by running.

**Blocked by:** [01](01-the-dump-sidecar.md) — these documents describe what exists, and until the
service lands they would be describing an intention.

**Status:** ready-for-agent

**The stance, in all four places it is written**

- [ ] DESIGN.md §10's Backups row, `docs/operating.md`'s Backups section, `ARCHITECTURE.md` §3's
      "documented rather than built in", and spec 0001's out-of-scope list all say the same new
      thing: the stack takes a verified dump on a schedule and leaves it on the host; off-site,
      encryption and history are the operator's
- [ ] DESIGN.md §10.1's "no separate worker service" paragraph names the exception and points at
      ADR-0009 rather than being quietly falsified

**Counts that a fifth service breaks**

- [ ] `ARCHITECTURE.md`'s "all four containers", `docs/operating.md`'s "all four drop every
      capability" and "all four services running and healthy", and `compose.yaml`'s "all four
      services" comment become rules rather than counts — `docs/README.md`'s first rule is the
      argument, and bumping four to five is not the fix

**Operator-facing**

- [ ] `docs/operating.md` gains: the dump service and its knobs in the environment table; what the
      collector must be pointed at (`volumes/dumps/`, `.env`, `allowed-emails.txt`) and what it must
      exclude (`volumes/db/`, a torn cluster); a copy-pasteable staleness check on
      `last-success.json`; and the retention the design assumes on the collector's side, since the
      seven local days are a hand-off window and not the history
- [ ] The compression paragraph in the Backups section is rewritten: it currently argues a custom
      dump is far smaller than the table, which assumes the default compression this design turns off
- [ ] The restore drill gains a cadence — quarterly, and after any Postgres major upgrade
- [ ] Restoring says how to read a dump the operator's own account may not own
- [ ] Upgrading and Restoring both say to stop `dump` first: `pg_dump` holds `ACCESS SHARE` for its
      whole run and a migration's `ACCESS EXCLUSIVE` queues behind it
- [ ] `docs/runbook.md` gains "my dumps have stopped", with the marker file, the healthcheck and the
      free-space refusal as the three things to look at
- [ ] `README.md`'s "the whole deployment" list gains the script
- [ ] `.env.example` documents the knobs with the caveat that they are read by the sidecar's own
      validation, not by `server/config.ts`

**Vocabulary**

- [ ] `CONTEXT.md` gains **Dump** and **Backup** as distinct terms, each with the words it avoids;
      "snapshot" stays out, because restic owns that word on the one page where both appear
- [ ] Every existing use of "backup" that means the local file is renamed — including
      `docs/runbook.md`'s "I need to restore from a backup" heading and its cross-references, and
      `README.md`'s "Take a backup first"
- [ ] `docs/specs/README.md`'s slice table and ticket-directory list carry 0014 and `dump/`
