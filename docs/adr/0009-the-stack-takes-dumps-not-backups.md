# The stack takes dumps; backups stay the operator's

Until now this repository refused to automate any part of backing up, in four places:
DESIGN.md §10 ("Documented `pg_dump` procedure. Not built in — self-hosters have their own, and a
half-built backup feature is worse than none"), [`docs/operating.md`](../operating.md)'s Backups
section, [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §3 ("exactly one backup target — `pg_dump`,
documented rather than built in"), and spec [0001](../specs/0001-foundation-day-zero.md)'s
out-of-scope list. A `dump` service now takes a verified dump on a schedule and leaves it on the
host. Copying it off the machine, encrypting it and keeping history remain entirely the operator's,
done by their own tool from outside this stack.

The old stance was right about the thing it feared and wrong about the scope it drew. What makes a
backup feature dangerous is looking like it works — so this one is built to be loud when it is not
working, and to promise only the half it actually does. The half it does not do is named in the
same sentence everywhere it is described, because "the stack backs you up" is exactly the false
belief the original decision was protecting against.

## What changed the mind

A documented procedure is a procedure somebody has to remember. The household's data changes on
upload days that are not on a schedule, and the recovery goal is now stated: survive losing the box,
and be able to step back to a state from some days ago. Neither is met by a command in a document.

The line moved to where it can be defended: **the stack produces a dump and never leaves the host.**
No restic inside the stack, no repository password, no remote credentials, no egress. That keeps
intact the property the deployment's whole security argument rests on — Caddy is the only container
that publishes a port, and nothing here reaches outward.

## This also reverses "no separate worker service"

DESIGN.md §10.1 argues the price poller runs in-process precisely so there is no second container:
"A worker container would mean two images, two deployments, and two places to read logs." This is
that second container, and the argument for the exception is specific rather than general:

- `pg_dump` is not in the application image and has no business being there — the client must match
  the server version, which is a fact about the database service, not the app.
- The app container is `read_only: true` with no volume. A dumping app would need a writable mount,
  which is the property that makes "the application container is stateless" checkable today.
- **A dump that stops when the app is down is worthless.** The failure this exists for is the one
  where the app is not running.

The cost is paid honestly: a fifth service, a second schedule, and a second place to read logs.

## Consequences

- The dumps are every balance, every statement and every original uploaded CSV, in plaintext, in
  the checkout. They are no more exposed than `./volumes/db/data` beside them, and no less: the
  host's disk is now the whole of the household's finances twice over. Files are written `0640`.
  Encryption is the operator's tool's job, and that is a deliberate acceptance, not an oversight.
- The `portfolio` role is a superuser — it is the role the image initialises. The dump service
  therefore *holds* rights it must never use; that it never runs `dropdb` is a property of a script
  under review, not of a grant. A least-privilege dump role is possible and is not done here.
- An unhealthy container restarts nothing and alerts nobody: Docker restart policies react to a
  process exiting, not to health. The freshness marker on the mount is the signal that reaches the
  operator's collector; the healthcheck is for a human reading `docker compose ps`.
- Counts in the documentation ("all four containers…") become rules rather than counts, per
  [`docs/README.md`](../README.md)'s first rule.
- The glossary now distinguishes a **dump** (what the stack writes, on this host) from a **backup**
  (what the operator's tool holds, off it). The stack never takes a backup.
