# The audit harness

These are the scripts the findings in
[`../../2026-09-01-net-worth-aggregation-audit.md`](../../2026-09-01-net-worth-aggregation-audit.md)
were produced with, kept so a reader can reproduce them rather than trust them. They are evidence,
not part of the application: nothing in `app/`, `server/` or `tests/` imports them, and nothing here
runs in CI.

They were run from a working copy at `audit/` in the repository root and still expect that path — a
few absolute paths (`/home/user/portfolio/audit/...`, the Playwright Chromium in `lib.mjs`) need
adjusting for another checkout. Copy the directory to `audit/`, point `CHROME` at your browser, and
follow the sequence at the end of the report.

What each file is for:

| File | What it does |
|---|---|
| `TEST-PLAN.md` | the plan, written before any data was generated |
| `gen_data.py` | generates the dataset **and** `ledger.json`, the ground truth the app never touches |
| `gen_cycle2.py`, `gen_cycle4.py` | the lot-level statement, and the four re-upload shapes |
| `lib.mjs`, `flows.mjs` | Playwright plumbing, and the app's real write workflows |
| `seed.mjs` | seeds people, accounts, statements and balances through the UI |
| `fake-refresh.mjs` | drives the app's own `refreshQuotes` with a deterministic provider |
| `cycle2.mjs`, `cycle3.mjs`, `cycle4.mjs`, `cycle5-close.mjs` | the four repeated-usage cycles |
| `scrape.mjs` | reads every figure the UI shows into JSON |
| `verify.py` | the three-way reconciliation: ledger → database → UI |
| `recompute.py` | an independent valuation over the raw rows, with no ledger |
| `sweep.mjs` | every filter, grouping, sort and owner slice, each checked for whether the parts add up |
| `drift.mjs` | repeated reads and repeated refreshes, watching for movement |
| `repro-owner-loop.mjs` | finding 1, standalone |
| `repro-silent-noop.mjs` | finding 2, standalone |
| `repro-unpriced.mjs`, `repro-fold-and-guard.mjs` | the edge cases that passed |
| `capture.mjs` | the report's figures |
