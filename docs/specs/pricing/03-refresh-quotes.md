# 03 — Refreshing quotes and the daily spine

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** The operation that turns quotes into value on screen. One call selects every
instrument fed by a symbol, asks for all of them at once, and writes two tiers: the `quote` row
`holding_valued` reads, and a row on the `price_daily` spine every chart stands on. Its harder job
is being honest about what it could not price — an omitted symbol keeps its last price and is
flagged stale, a foreign-currency quote is refused outright, and a symbol that never had a price
stays visibly unpriced rather than being invented as zero. The daily row is filed under the date
inside the quote's own timestamp, which is what keeps an afternoon mutual-fund poll from recording
yesterday's NAV as today's close, and what keeps a holiday poll from manufacturing a row DESIGN.md
§6.2 says should not exist.

This ticket adds no column and no table — the §4.1 schema already holds everything it writes.

**Blocked by:** 01, 02.

**Status:** ready-for-agent

**Selection**

- [ ] Instruments with price source `feed` and a non-null symbol are refreshed
- [ ] Instruments with price source `fixed` or `manual` are never sent to the provider, so the
      seeded `USD` row at 1.00 and every collective investment trust are left alone
- [ ] Symbols are deduplicated into a single batched call
- [ ] Two instruments sharing one symbol are both updated from that one quote, since the symbol
      column carries no unique constraint
- [ ] With no instruments to price, no provider call is made

**The quote row**

- [ ] A successful quote upserts price, yield percent, annual dividend per share and as-of for that
      instrument, and clears its stale flag
- [ ] As-of is the provider's own timestamp for the quote, not the moment of the write
- [ ] The instrument's quote type is recorded from what the provider reports
- [ ] `holding_valued` reports the refreshed value immediately afterwards, with no view change

**The daily spine**

- [ ] The `price_daily` row is keyed on the calendar date of the quote's own timestamp, resolved in
      the market timezone — never on the date of the poll
- [ ] A quote timestamped yesterday afternoon rewrites yesterday's row, so an afternoon poll of a
      mutual fund does not file its previous NAV as today's close
- [ ] A refresh run on a market holiday rewrites the previous trading day's row and creates no row
      for the holiday, so non-trading days keep no `price_daily` row (§6.2)
- [ ] Repeated refreshes during a session leave exactly one row for that date, holding the latest
      price, so today's row converges on the close with no end-of-day job
- [ ] A row for a past date is never modified by a refresh
- [ ] A quote arriving with no usable timestamp updates the quote row but writes no daily row,
      rather than falling back to the current date

**Failure, told honestly**

- [ ] A symbol omitted from the response keeps its last known price and is marked stale — never zero
      and never null into a sum (§6.2)
- [ ] An instrument that has never been quoted and is omitted gets no row at all, and continues to
      report as unpriced through `holding_valued`
- [ ] A non-USD quote writes neither a price nor a daily row, marks the instrument stale, and is
      logged naming the symbol and the currency
- [ ] A provider call that throws marks every selected instrument stale and writes no price
- [ ] A refusal and an omission in the same batch do not stop the healthy symbols in that batch from
      being written
- [ ] The operation returns a summary — how many were updated, marked stale, and refused — for the
      poller to log and the UI to report

**Numerics**

- [ ] Every value reaches Postgres as a fixed-scale decimal string; no price or yield is passed as a
      JavaScript number
