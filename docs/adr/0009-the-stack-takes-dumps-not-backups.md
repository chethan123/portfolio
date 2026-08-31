# The stack takes dumps; backups stay the operator's

Everywhere this deployment describes itself, it said backups would never be built in: DESIGN.md §10
("Documented `pg_dump` procedure. Not built in — self-hosters have their own, and a half-built
backup feature is worse than none"), [`docs/operating.md`](../operating.md)'s Backups section,
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) §3 ("exactly one backup target — `pg_dump`, documented
rather than built in"), `compose.yaml`'s own comments, and the foundation specs. We are reversing
that. A `dump` service will take a verified dump on a schedule and leave it on the host; copying it
off the machine, encrypting it and keeping history remain entirely the operator's, done by their own
tool from outside this stack.

The old stance was right about the thing it feared and wrong about the scope it drew. What makes a
backup feature dangerous is looking like it works — so this one is built to be loud when it is not
working, and to promise only the half it does. The half it does not do is named in the same sentence
everywhere it is described, because "the stack backs you up" is exactly the false belief the
original decision was protecting against.

## What changed the mind

A documented procedure is a procedure somebody has to remember. The household's data changes on
upload days that are not on a schedule, and the recovery goal is now stated: survive losing the box,
and be able to step back to a state from some days ago. Neither is met by a command in a document.

The line moved to somewhere defensible: **the stack produces a dump and never leaves the host.** No
backup tool inside the stack, no repository password, no remote credentials, no egress. That keeps
intact the property the deployment's security argument rests on — Caddy is the only container that
publishes a port, and nothing here reaches outward.

## This also reverses "no separate worker service"

Three places argue there is no second container: DESIGN.md §10.1 ("A worker container would mean two
images, two deployments, and two places to read logs"), `ARCHITECTURE.md` §3.1's "**No worker
container**", and `compose.yaml`'s header. This is that second container, and the argument for the
exception is specific rather than general:

- `pg_dump` is not in the application image and has no business being there — the client must match
  the server version, which is a fact about the database service, not the app.
- The app container is `read_only: true` with no volume. A dumping app would need a writable mount,
  which is the property that makes "the application container is stateless" checkable today.
- **A dump that stops when the app is down is worthless.** The failure this exists for is the one
  where the app is not running.

The cost is paid honestly: a fifth service, a second schedule, and a second place to read logs.

## Considered options

- **Leave it documented.** Rejected: it is what exists, and it depends on somebody remembering.
- **A host cron job or systemd timer calling `docker compose exec`.** Rejected because it is
  untested and unversioned — it lives on one machine, is retyped slightly differently on the next,
  and no CI run ever proves it works.
- **A backup tool inside the stack, pushing to a repository.** Rejected: it needs egress, a
  repository password and remote credentials inside a deployment whose whole security argument is
  that only Caddy reaches anywhere. It also merges two failure modes — "the dump broke" and "the
  upload broke" — into one silence.
- **Dumping from the app container's in-process scheduler.** Rejected on the three grounds above.
- **A dedicated least-privilege dump role.** Not done. It needs a password, a bootstrap step and
  `pg_read_all_data` to see everything; the honest position is recorded under Consequences instead.

## Consequences

- **Uncompressed by default.** `--compress=0` costs local disk — several times the compressed size
  — and buys deduplication in the operator's tool, which cannot deduplicate a freshly compressed
  blob and would otherwise store a full copy per run. The disk that pays for it is the one the live
  cluster sits on, which is why the run refuses to start below a free-space floor, and why the knob
  exists for an operator who would rather spend CPU than disk.
- **The dumps are readable to the operator's own account, and the cluster beside them is not.**
  `./volumes/db/data` is `0700` uid 70; these are `0640` under the operator's uid, deliberately, so
  that whatever collects them can read them. They are every balance, every statement and every
  original uploaded CSV in plaintext. Encryption is the collecting tool's job. That is an
  acceptance, not an oversight.
- The `portfolio` role is a superuser — it is the role the image initialises. The dump service
  therefore *holds* rights it must never use; that it never runs `dropdb` is a property of a script
  under review, not of a grant.
- An unhealthy container restarts nothing and alerts nobody — the same fact `docs/operating.md`
  already states under "An unhealthy container is not restarted", repeated here deliberately
  because it decides the design: the marker file on the mount is the signal that reaches the
  operator's collector, and the healthcheck is for a human reading `docker compose ps`.
- Counts in the documentation ("all four containers…") become rules rather than counts, per
  [`docs/README.md`](../README.md)'s first rule.
- The glossary now distinguishes a **dump** (what the stack writes, on this host) from a **backup**
  (what the operator's tool holds, off it). The stack never takes a backup.
