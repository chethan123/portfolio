# 02 — Documents and vocabulary

_Part of [0014-scheduled-dump.md](../0014-scheduled-dump.md)._

**What to build:** Nothing that runs. Every document that describes this deployment is brought level
with a stack that now takes dumps, and `CONTEXT.md` gains the pair of terms that keeps the promise
honest — a **dump** is what this host holds, a **backup** is what the operator's tool holds
elsewhere. That split makes existing sentences wrong by its own definition, so the rename pass is
part of this ticket rather than a follow-up.

Separate from [01](01-the-dump-sidecar.md) because a prose diff of this size is reviewed by reading
and a container is reviewed by running.

**Blocked by:** [01](01-the-dump-sidecar.md) — these documents describe what exists, and until the
service lands they would describe an intention.

**Status:** ready-for-agent

**The backups stance, everywhere it is written**

- [ ] DESIGN.md §10's Backups row and §10.1's "backups have exactly one target"
- [ ] `docs/operating.md`'s Backups section, including its second thing to keep
- [ ] `ARCHITECTURE.md` §3's "One store… exactly one backup target — `pg_dump`, documented rather
      than built in" — `./volumes/dumps` is now a second persistent directory in the deployment
- [ ] `compose.yaml`'s `db-store` comments: "Still the single backup target" and "one path to
      snapshot, move between machines, or point a backup at"
- [ ] `docs/specs/0001-foundation-day-zero.md` and
      `docs/specs/foundation/09-proxy-trust-and-operator-docs.md` get a
      **`Superseded in one clause:`** banner pointing at 0014 and ADR-0009, in the form
      `foundation/09` already uses — `docs/specs/README.md` says a landed spec records what was
      agreed at approval time and is corrected by banner, not by rewriting its history

**The worker-service stance**

- [ ] DESIGN.md §10.1's "no separate worker service" paragraph, `ARCHITECTURE.md` §3.1's "**No
      worker container**" bullet, `compose.yaml`'s file header, and `README.md`'s "there is no
      worker container" under Where prices come from all name the exception and point at ADR-0009
      rather than being quietly falsified

**Counts a fifth service breaks — rewritten as rules, not bumped to five**

- [ ] `ARCHITECTURE.md`: "all four containers are `read_only: true`", "on all four… pinned on
      three", and §3.1's topology diagram
- [ ] `docs/operating.md`: the "What runs here" service table, "all four drop every Linux
      capability", "three run as an unprivileged uid", "all four services running and healthy"
- [ ] `compose.yaml`'s "Privilege posture, all four services" comment
- [ ] DESIGN.md §10's Packaging row, §10.1's service block and its "one decision rather than four"
- [ ] `docs/README.md`'s first rule is the argument for making these rules rather than counts

**Where the new service needs an entry**

- [ ] `ARCHITECTURE.md` §7.4's observability table (the freshness markers and the healthcheck),
      Appendix A's `scripts/` table (`dump-loop.sh`), and §3.3's Compose-level variables
- [ ] DESIGN.md §10.1's environment surface table
- [ ] `docs/operating.md`'s "Running against your own Postgres", which tells the operator to delete
      the `db` service and `app`'s `depends_on`: this service and its own `depends_on` go with them,
      or Compose rejects the edited deployment outright
- [ ] `docs/operating.md`: the environment table; Installing and "Where the database lives", which
      now need a second `mkdir -p` and the `DUMP_UID`/`DUMP_GID` that must match it; the Logs
      section, for the script's grep stem; and "An unhealthy container is not restarted", which now
      governs this service too

**Operator-facing, and the instructions this design falsifies**

- [ ] The Backups section's `pg_restore --list` check — "if it prints the objects, the file is a
      real archive" — and `docs/runbook.md`'s copy of it become `pg_restore -f /dev/null`, because
      a truncated archive passes `--list`
- [ ] The compression paragraph, which argues a custom dump is far smaller than the table on the
      assumption of default compression this design turns off
- [ ] What the collector must be pointed at (`volumes/dumps/`, `.env`, `allowed-emails.txt`), what
      it must exclude (`volumes/db/`, a torn cluster), a copy-pasteable staleness check on the
      success marker, and the retention it must keep — the local window is a hand-off, not the
      history
- [ ] Verification recipes name `docker compose ps -a`, or a disabled dumper is indistinguishable
      from one that was never there
- [ ] The restore drill gains a cadence: quarterly, and after any Postgres major upgrade
- [ ] Restoring says how to read a dump when the operator's account does not own it
- [ ] Upgrading and Restoring both say to stop `dump` first — `pg_dump` holds `ACCESS SHARE` for its
      whole run and a migration's `ACCESS EXCLUSIVE` queues behind it — and, because a bare
      `docker compose up -d` would start it again mid-migration and the restore recipe ends with a
      targeted `start app` that would leave it stopped for good, both procedures name the services
      they start and end with an explicit `docker compose start dump`
- [ ] `docs/runbook.md` gains "my dumps have stopped" — the markers, the healthcheck under `ps -a`,
      and the free-space refusal are the three things to look at
- [ ] `README.md`'s "the whole deployment" list gains the script and the dumps directory

**Vocabulary**

- [ ] The **Dump** and **Backup** entries landed with ADR-0009 in the decision commit, because a
      term earns its entry when it is resolved. This ticket is the pass that makes the rest of the
      documentation obey them, and until it lands the glossary and the runbook disagree
- [ ] Every use of "backup" meaning the local archive is renamed, found by searching the repository
      rather than by working through a list — an enumeration here would be a fifth place to keep in
      step. The ones already known: `docs/runbook.md`'s "I need to restore from a backup" heading
      and its cross-references, `README.md`'s "Take a backup first" and its "`pg_dump` backup and
      restore procedure", and the uses in `docs/guide/upload.md`, `docs/google-sign-in.md` and
      `docs/developing.md`
- [ ] `docs/specs/README.md`'s slice table and ticket-directory list carry 0014 and `dump/`
