# 03 — The two hardening rules

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1)._

**What to build:** Two rules in the app's own price path, against the provider it has today: a price
ceiling in `toProviderQuote`, a sibling of the rate and close ceilings that already exist, so one
absurd figure cannot abort a whole refresh; and a seven-day window, both sides of today, outside
which the quote path writes no `price_daily` close — so a hostile or merely wrong
`regularMarketTime` can neither rewrite the past nor plant the future.

Its own ticket because both rules guard against an honest provider's bad day as much as against a
hostile worker, both are pure domain rules with fixture-shaped tests, and neither shares a line with
[01](01-one-refresh-and-the-batch-abort.md) or [02](02-the-batched-probe.md).

**Blocked by:** Nothing. Parallel with [01](01-one-refresh-and-the-batch-abort.md),
[02](02-the-batched-probe.md) and [04](04-the-mailbox-and-the-worker-role.md).

**Status:** ready-for-agent

**The ceiling** (`app/lib/price-provider.server.ts`)

- [ ] `PRICE_CEILING = 10 ** 16` beside `RATE_CEILING` (`:208`) and `CLOSE_CEILING` (`:219`),
      applied in `toProviderQuote` through `inRange` (`:231-234`): a price at or over it is dropped,
      not clamped, so the quote is `null` and the symbol goes stale. The docstring gives the
      siblings' reasoning, not a reader's: `quote.price` is `numeric(20, 4)`
      (`migrations/0001_initial_schema.sql:219`), so a figure of sixteen integer digits aborts the
      statement and with it the refresh transaction — every instrument stale for one bad symbol.
      What the ceiling does not guard, and says so: the reader's `quantity × price` product
      (`0006_annual_dividend.sql:149`), which no price ceiling can — `quantity` is `numeric(20, 8)`
      (`0001:186`) and `fitsTheMoneyColumn` (`app/lib/positions.server.ts:206`) guards the product
      at the quantity write; spec §8 keeps it as a residual

**The window** (`app/lib/prices.server.ts`)

- [ ] The close write (`writeDailyClose`, `:931-950`, called at `:821-827`) is skipped — no insert,
      no update — when the quote's market date is more than seven days before **or after** today's
      market date in `marketTimeZone`; the quote and the observation still land. Symmetric because
      the upsert is keyed by `regularMarketTime` (`:944-947`): a past date rewrites a recorded
      close, which ADR-0011's immutability covers only for the backfill writer, and a future date
      plants a close on a day to come that is permanent whenever that day is a weekend or holiday
      the poller never overwrites
- [ ] The constant sits beside `BACKFILL_RANGE_LEAD_DAYS` (`:106`) with the reasoning: seven is the
      lag an honest NAV or a holiday quote can carry, and a week clears the longest run of
      non-trading days. The day arithmetic uses `addDays` on an `IsoDate`, exported from
      `app/lib/chart-range.ts:139` (private today) rather than written a fourth time
- [ ] One `console.warn` per refresh naming the instruments whose close was skipped; the module
      header's account of which past rows a refresh can rewrite is updated with the rule

**Tests**

- [ ] `tests/price-provider.test.ts`: a `regularMarketPrice` at the ceiling yields `null`, one below
      it a string
- [ ] `tests/refresh-quotes.test.ts`: with `vi.useFakeTimers({ toFake: ["Date"] })`
      (`tests/price-backfill.test.ts:930-941` is the shape), a fake quote struck eight days before
      today's market date writes `quote` and the observation but no `price_daily` row, and leaves a
      seeded row for that day byte-identical; one struck eight days ahead writes no close either;
      one struck seven days before writes the close

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
