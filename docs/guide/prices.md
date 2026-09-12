# Why a number did not change

Prices mostly look after themselves, so this page is three short answers.

## "My total is the same as yesterday"

The **As of** header shows the oldest provider timestamp among currently held feed-priced
instruments across the household. It is not the last fetch time. A successful refresh may return
the same timestamp and price.

Scheduled quotes run around market hours at the cadence in Settings → Prices. **Refresh now** can
ask at any hour. Mutual funds often publish one daily price; stocks also stay unchanged while
markets are closed. Provider failures keep the last stored price and mark it stale.

Settings → Prices lists missing historical coverage, not every stale current quote. If a refresh
fails, check the inline result and ask the operator to inspect the pricing logs.

## "This holding shows a dash"

A dash means no stored price is available. A failed later poll retains the previous price and marks
it stale. An unpriced holding contributes no value to net worth. Known basis or dividend figures can
still contribute to their own totals.

Historical valuation needs a daily close on or before the requested date. Backfill fills missing
earlier coverage when the provider supports it; some gaps remain. The app has no manual-price
editor yet. A stale price differs from a missing price: the last known value still counts.

## Everything is in dollars

The app is USD only. It does not convert currencies, and it refuses a foreign-currency price rather
than guessing an exchange rate. A holding quoted in another currency cannot be priced here.

---

The reasoning behind all of this — why an unpriceable holding is excluded rather than zeroed, and
why a quote is filed under the day the market gave it — is in
[the README](../../README.md#where-prices-come-from).

**Next:** [Settings](settings.md) — the dials behind these screens, the refresh cadence among them.
