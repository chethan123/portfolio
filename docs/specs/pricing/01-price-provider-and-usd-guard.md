# 01 — The price provider and the USD guard

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** The single seam through which every price in the application arrives — one
batched call for all symbols, one `yahoo-finance2` adapter behind it, one fake behind it for tests,
and nothing else in the codebase aware of which provider is in use. It is also where two silent
money bugs are stopped at the boundary: a yield taken from the wrong field, which lands on the
Income page wrong by a factor of a hundred, and a quote priced in a currency that is not dollars,
which would sum straight into a USD total. Nothing is written to the database by this ticket; it
produces quotes and refusals.

**Blocked by:** none.

**Status:** ready-for-agent

**The interface**

- [ ] One `PriceProvider` interface with a single method taking a list of symbols and returning
      quotes, exactly as DESIGN.md §6.1 states — one batched call, not one call per symbol
- [ ] A quote carries symbol, price, currency, yield percent, annual dividend per share, quote type,
      and the provider's own as-of instant
- [ ] `yahoo-finance2` is imported by the adapter module and by nothing else, so swapping to FMP
      (§6.1) touches one file
- [ ] A fake implementation of the same interface ships as test support, able to produce a delisted
      symbol, a non-USD quote, an after-the-close timestamp and a throwing call
- [ ] No test in the suite makes a network call

**Yields**

- [ ] The yield comes from the provider field reported as a percent, so a 2.34% yielder produces
      `2.34`
- [ ] The field reported as a fraction is never read, and the adapter records why in a comment
- [ ] When the percent field is absent, the yield is derived from the annual dividend rate and the
      price
- [ ] A fixture supplying both yield fields with mutually inconsistent values proves which one is
      used

**The USD guard**

- [ ] A quote whose currency is not USD is refused rather than returned as a price
- [ ] A refusal names the symbol and the currency that caused it, so the caller can log it and the
      UI can explain it
- [ ] A refused symbol does not prevent the rest of the batch from being returned

**Partial results and failure**

- [ ] A symbol absent from the provider's response is reported as missing, not as an error for the
      whole batch, since Yahoo omits delisted and unknown symbols rather than failing
- [ ] A call that throws — network failure, rate limit, a changed endpoint — surfaces as one failed
      batch and yields no partial results
- [ ] An empty symbol list makes no call at all

**Numerics**

- [ ] Prices, yields and dividends leave the adapter as fixed-scale decimal strings, converted once
      at the boundary, never as JavaScript numbers (DESIGN.md §4.1)
