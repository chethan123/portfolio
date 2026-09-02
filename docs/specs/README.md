# Specs

Approved work, written before it is built — the charter is [`../README.md`](../README.md)'s. A
numbered spec approves one slice; a slice that breaks into tickets gets a directory beside it, one
file per ticket, each written so an agent that has read nothing else can start from it
([`ingest/02-tolerant-csv-reader.md`](ingest/02-tolerant-csv-reader.md) is the shape to copy).

## How to read a spec's status

A spec records what was agreed at approval time, and is mostly not edited after its slice lands:
the tree and `git log` are the record of what shipped, so a `ready-for-agent` label on an old spec
is a fact about its filing, not about today. Two deliberate exceptions:

- **A claim that turned out wrong is corrected in place** — the `Superseded` banners on
  [`foundation/01`](foundation/01-runnable-skeleton.md),
  [`foundation/08`](foundation/08-optional-password-gate.md) and
  [`foundation/09`](foundation/09-proxy-trust-and-operator-docs.md) are the pattern.
- **[`pricing/06`](pricing/06-refresh-now-control.md) is marked `built` with its acceptance list
  ticked** — the one spec whose builder flipped it on landing. Earlier specs were not revisited to
  match.

## The slices

| Spec | What it approved |
|---|---|
| [0001](0001-foundation-day-zero.md) | Day zero: schema, the valuation view, people and accounts, health |
| [0002](0002-pricing.md) | Pricing: the provider seam, market calendar, refresh, in-process poller |
| [0003](0003-holdings.md) | The Holdings table: filtering, grouping, subtotals, money maths |
| [0004](0004-ingest.md) | The four-screen statement upload over a durable draft |
| [0005](0005-report-remediation.md) | Fixes sequenced from the exploratory report — the date floor and the return path have landed; pool resilience, the nameless-quantity refusal and the filed-behind statement are still owed |
| [0006](0006-dividends.md) | The Income screen and `annual_dividend` through the valuation contract |
| [0007](0007-masking.md) | Masking: policy row, per-browser state, the one amount renderer |
| [0008](0008-chart-ranges.md) | The chart range presets, cookie and custom span |
| [0009](0009-dynamic-chart-resolution.md) | Anchored geometric sampling under a point budget (ADR-0003) |
| [0010](0010-chart-point-readout.md) | The pre-rendered per-point readout (ADR-0004) |
| [0011](0011-auth-gate.md) | The forward-auth gate replacing the in-app password (ADR-0005) |
| [0012](0012-installable-pwa.md) | The installable shell and the storage-free worker (ADR-0007) |
| [0013](0013-owner-filter.md) | The household-wide owner filter (ADR-0008) |
| [0014](0014-scheduled-dump.md) | The scheduled dump sidecar and the dump/backup split (ADR-0009) |
| [0015](0015-chart-series-assembly.md) | One series assembly behind both chart surfaces, and the coverage rule off the routes |
| [0016](0016-session-series-running-total.md) | The 1D line as a running total over the session's observations, same rows in tens of milliseconds |
| [0017](0017-price-backfill.md) | The price spine backfilled from the feed's own history — gap-triggered, on every refresh, inserted where absent, never over a live close (ADR-0011) |

## The ticket directories

[`foundation/`](foundation/) (spec 0001), [`ingest/`](ingest/) (0004), [`pricing/`](pricing/)
(0002 — [`05`](pricing/05-pricing-ui.md)'s stale summary and Settings → Instruments are the part of
the slice still unbuilt), [`holdings/`](holdings/) (0003), [`auth-gate/`](auth-gate/) (0011),
[`dynamic-chart-resolution/`](dynamic-chart-resolution/) (0009),
[`owner-filter/`](owner-filter/) (0013), [`dump/`](dump/) (0014), and
[`price-backfill/`](price-backfill/) (0017).

A `screenshots/` directory under a slice holds before/after proof for one ticket's pull request and
is deleted once that pull request merges — a lasting image belongs to the README's or the guide's
set ([`../README.md`](../README.md)).
