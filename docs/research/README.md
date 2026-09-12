# Research

Dated investigations, audits, and proposals. Their findings, benchmarks, package versions, and
completion statements describe the revision examined; they are not a current bug list or a
security guarantee. Check the code and tests before acting on a finding.

Approved work is in [specs](../specs/README.md). Current behavior is documented in the
[user guide](../guide/README.md), [architecture](../../ARCHITECTURE.md), and [data model](../data-model.md).
Keep original evidence and rejected options intact; add a dated follow-up when a result changes.

## Reports

- [Useful additions to Analysis](2026-09-11-analysis-visualization-opportunities.md) — 2026-09-11.
- [Pricing health on `/healthz` — feasibility of spec 0021](2026-09-08-price-health-feasibility.md) — 2026-09-08.
- [Price-fetch coordination and containment audit](2026-09-07-price-fetch-coordination-audit.md) — 2026-09-07.
- [The lock slice, reviewed before launch](2026-09-05-lock-slice-launch-review.md) — 2026-09-05.
- [Price worker platform facts — 4 September 2026](2026-09-04-price-worker-platform-facts.md) — 2026-09-04.
- [Security and privacy audit](2026-09-02-security-and-privacy-audit.md) — 2026-09-02.
- [Why the Overview takes eleven seconds with 1D selected — 1 September 2026](2026-09-01-overview-1d-latency.md) — 2026-09-01.
- [Net worth aggregation audit — 1 September 2026](2026-09-01-net-worth-aggregation-audit.md) — 2026-09-01.
- [Account pickers and file-to-account mapping — how established apps do it](2026-08-30-account-picker-conventions.md) — 2026-08-30.
- [Codex review validation — independent audit](2026-08-29-codex-review-validation.md) — 2026-08-29.
- [Portfolio Tracker: data model and architecture review](2026-08-28-codex-review.md) — 2026-08-28.
- [Upload UX review — the statement workflow, walked as a household](2026-08-25-upload-ux-review.md) — 2026-08-25.
- [Broker header aliases, and what matching them can and cannot do](2026-08-25-broker-header-aliases.md) — 2026-08-25.
- [Exploratory test report — 2026-08-24](2026-08-24-exploratory-test-report.md) — 2026-08-24.
- [Dependency audit](2026-08-23-dependency-audit.md) — 2026-08-23.
- [Architecture review — deepening opportunities](2026-08-23-architecture-review.md) — 2026-08-23.
- [Stitch screen audit — `Portfolio Net Worth Tracker`](2026-08-19-stitch-screen-audit.md) — 2026-08-19.
- [Screen recommendations — from the Stitch set to a FIRE instrument](2026-08-19-screen-recommendations.md) — 2026-08-19.
- [Market analysis — self-hosted portfolio trackers and the FIRE audience](2026-08-19-market-analysis.md) — 2026-08-19.
- [Data-layer design — Independence, Rebalance and Holdings](2026-08-19-fire-data-layer-design.md) — 2026-08-19.

## Reproduction material

New reports keep scripts in `harness/` and captures in `figures/`. Older reports may link a separate
capture directory, including the Stitch and account-picker reports above. Read the report's
setup and cleanup steps first: some harnesses replace demo data or start disposable services.
