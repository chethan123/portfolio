# 03 — The three hardening rules

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1)._

**What to build:** Three rules in the app's own price path, against the provider it has today, and a
cap on what one observation archives: a price ceiling in `toProviderQuote`, a sibling of the rate
and close ceilings that already exist, so one absurd figure cannot abort a whole refresh; a
seven-day window, both sides of today, outside which the quote path writes no `price_daily` close —
so a hostile or merely wrong `regularMarketTime` can neither rewrite the past nor plant the future;
a floor in `toProviderHistory` at `range.from`, the mirror of the cut it already makes at `until`, so
one bar dated before first-held cannot close a coverage gap for good; and `archived()` refusing a
payload over 32 KB, so a worker cannot turn the observation log into the disk.

Its own ticket because every rule guards against an honest provider's bad day as much as against a
hostile worker, all are pure domain rules with fixture-shaped tests, and none shares a line with
[01](01-one-refresh-and-the-batch-abort.md) or [02](02-the-batched-probe.md).

**Blocked by:** Nothing. Parallel with [01](01-one-refresh-and-the-batch-abort.md),
[02](02-the-batched-probe.md) and [04](04-the-price-worker-process.md).

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
- [ ] The skip has to reach the caller, because `refreshQuotes` counts the write unconditionally:
      `closes += 1` follows the `await writeDailyClose(…)` with nothing between them
      (`prices.server.ts:824-826`). So `writeDailyClose` reports whether it wrote — the window guard
      decides before the upsert runs, so a `Promise<boolean>` says it — and the loop increments
      `closes` only when it did.
      Acceptance: `RefreshReport.closes` (`:161`, "`price_daily` rows written or rewritten")
      excludes every skipped write, and the log line built from the report with it, so a refresh
      whose every close was out of window reports `closes: 0`; `priced`, `stale` and `observed` are
      unaffected — the quote and the observation still land
- [ ] The constant sits beside `BACKFILL_RANGE_LEAD_DAYS` (`:106`) with the reasoning: seven is the
      lag an honest NAV or a holiday quote can carry, and a week clears the longest run of
      non-trading days. The day arithmetic uses `addDays` on an `IsoDate`, exported from
      `app/lib/chart-range.ts:139` (private today) rather than written a fourth time
- [ ] One `console.warn` per refresh naming the instruments whose close was skipped; the module
      header's account of which past rows a refresh can rewrite is updated with the rule

**The floor** (`app/lib/price-provider.server.ts`)

- [ ] `toProviderHistory` (`:483`) skips a bar whose market date is before `range.from` exactly as
      it skips one at or past `range.until` (`:541`, today the only date cut). The reason, in the
      docstring beside the `until` sentence: `writeBackfilledCloses` inserts where absent
      (`prices.server.ts:988`), so a bar dated 1971 lands as a row; the gap predicate
      `NO_CLOSE_BY_FIRST_HELD` (`:253-258`) is satisfied by any row dated at or before first-held,
      so that one row removes the instrument from the candidate set permanently while the ledger
      says `filled` and the real gap — first-held back to the spine's true start — is never filled;
      ADR-0011 forbids overwriting a close and nothing in the app deletes `price_daily`, so the
      recovery would be `psql`. An honest answer never carries a bar before `period1`, which is
      `from`, so the cut costs nothing

**The archive cap** (`app/lib/prices.server.ts`)

- [ ] `archived()` (`:1015-1024`) answers `null` for a payload whose serialised form is over 32 KB,
      measured as `Buffer.byteLength(json, "utf8")` rather than the string's own `.length` — a
      quote's raw entry can carry non-ASCII text (a foreign exchange's company name, a currency
      symbol) whose UTF-8 encoding runs longer than its UTF-16 code-unit count, and the cap is about
      the bytes the row costs on disk, not the character count. `ARCHIVE_PAYLOAD_CAP`, beside the
      function, with the reasoning: an honest quote entry is 2–4 KB; the observation log keys on
      `(instrument_id, as_of)` and inserts where absent (`:1072`), so a worker varying
      `regularMarketTime` adds a row per instrument per tick, and uncapped each row could carry the
      client's whole body cap into the cluster that shares a filesystem with the dumps. One
      `console.warn` naming the symbol and the size, in the shape of the function's
      serialise-failure line (`:1021`); `null` is "treated as absent" by the function's own contract
      and the column is nullable (`migrations/0009_price_observation.sql:64`), so the quote and the
      observation still land, without the document

**Tests**

- [ ] `tests/price-provider.test.ts`: a `regularMarketPrice` at the ceiling yields `null`, one below
      it a string
- [ ] `tests/refresh-quotes.test.ts`: with `vi.useFakeTimers({ toFake: ["Date"] })`
      (`tests/price-backfill.test.ts:930-941` is the shape), a fake quote struck eight days before
      today's market date writes `quote` and the observation but no `price_daily` row, leaves a
      seeded row for that day byte-identical, and comes back with `closes: 0` in the report; one
      struck eight days ahead writes no close either; one struck seven days before writes the close
      and reports `closes: 1`
- [ ] The six existing cases that assert a written close (`tests/refresh-quotes.test.ts:125`, `:169`,
      `:203`, `:227`, `:247`, `:357`) carry June-2026 `asOf` fixtures against the real clock and need
      the same fake clock, or an `asOf` relative to now
- [ ] `tests/price-provider.test.ts`, "reading a day of history" (`:421`): a chart carrying one bar
      dated before `RANGE.from` (`:380`) and one inside the range yields the inside close only — the
      bar before the range is not written
- [ ] `tests/price-backfill.test.ts`, "what a batch writes to the spine" (`:611`): the real adapter
      over a client stub (`tests/price-provider.test.ts:704-786` is the shape) whose chart carries a
      single bar dated 1971 for an instrument first held in 2024 writes no `price_daily` row. The
      floor drops that lone bar before `range.from`, so `toProviderHistory` returns `no-history`
      exactly as an empty chart would (`price-provider.server.ts:562-575`) — a pre-range-only
      answer is indistinguishable from none — and the ledger records `no_history`, leaving the
      instrument in the gap list; the bar does not close the gap
- [ ] `tests/refresh-quotes.test.ts`: a fake quote whose raw entry serialises to 33 KB lands its
      `quote` row and an observation whose `payload` is `null`, with the warning naming the symbol;
      one at 4 KB archives the document; a multibyte entry whose `.length` sits under the cap but
      whose UTF-8 byte length sits over it — three-byte characters padding a company name — is
      archived as `null` too, the case that pins `Buffer.byteLength` over the string's own `.length`

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build` green
