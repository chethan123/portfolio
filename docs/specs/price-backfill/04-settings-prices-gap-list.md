# 04 — The gap list on Settings → Prices

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** A list on Settings → Prices (`app/routes/settings/prices.tsx`) of every
instrument still carrying a coverage gap — what it is, when it was first held, where its spine
begins, and the date and outcome of the last backfill attempt — fed by one new read in
`app/lib/prices.server.ts`. It is the household's answer to "why is this still unpriced in
March" and the operator's list of tickers to check against a statement, and until it exists the
ledger is readable only through `psql`.

Its own ticket because it is a screen: reviewed by looking, retaken in a screenshot, and touching
no rule the batch enforces.

**Blocked by:** [02](02-the-ledger-and-the-gap-query.md) for the table,
[03](03-the-backfill-step-in-every-refresh.md) for there to be attempts to list.

**Status:** ready-for-agent

**The read** (`backfillGaps(db)`, exported from `app/lib/prices.server.ts`)

- [ ] The same gap predicate as `selectBackfillCandidates` — a spine that starts later than the
      instrument's first-held date, or none — over every instrument whose `price_source` is not
      `fixed`: `manual` instruments and symbol-less `feed` instruments have a gap just as real, and
      the screen is where a person learns the batch will never fill it. The two reads share the
      predicate in one place rather than restating it
- [ ] No retry skip and no bound: this is the whole list, not the next batch
- [ ] Per row: the instrument's id, symbol and name; the first-held date; the first close, null
      when there is none; the latest `price_backfill` row's `started_at`, `outcome` and `error`,
      null when none — read through the `(instrument_id, started_at desc)` index; and whether the
      batch will try it, which is `feed` with a symbol
- [ ] Ordered as the batch is — first-held date, then id — so the top of the list is what the next
      refresh works on
- [ ] Dates and ids cross as strings; nothing is computed

**The screen** (`app/routes/settings/prices.tsx`)

- [ ] The loader (`:19-21`) adds the list beside the cadence; the action is unchanged
- [ ] A second panel below the cadence form, in the page's existing panel form, one row per gap:
      the instrument by name and symbol, first held, first close or that there is none, and the
      last attempt's date with its outcome in words — the six outcomes mapped to short sentences in
      the component, rendering and not a rule; the provider's error text shown for a failure. A
      row the batch will never try says why instead of an attempt
- [ ] An empty list is one sentence saying the spine covers everything held, in the page's own
      empty-state form
- [ ] The subtitle (`:54-58`) and the cost note (`:103-107`) stop claiming that nights, weekends and
      holidays cost nothing whatever the cadence says: quotes cost nothing outside market hours, and
      a backfill batch runs whenever there is a gap to fill, at most a handful of requests per
      refresh, and none once the list is empty. The storage note (`:114-119`) is unchanged
- [ ] Works with JavaScript off, as the page does now: a list is a list
- [ ] Amounts are not involved, so masking has nothing to do here; dates and names render unmasked
      as every date and name does

**Screenshots**

- [ ] `docs/guide/images/settings-prices.png` is retaken with `scripts/capture-screenshots.ts`, per
      `docs/README.md`'s rule that a change to a screen is not finished until they are. Against the
      demo household the list is whatever the seed produces; if that is the empty sentence, the
      shot shows the empty sentence

**Tests**

- [ ] `backfillGaps` in `tests/price-backfill.test.ts`, through `withDatabase`: a `manual`
      instrument with a gap is listed and marked as one the batch will not try; a `fixed` instrument
      never is; an instrument with attempts reports the latest one's date and outcome, not the
      first's; one with none reports null; the order matches the batch's
- [ ] The component, through `renderToStaticMarkup` and `toContain` fragments as the other settings
      pages are tested: a row renders its instrument and outcome; the empty sentence renders when
      the list is empty
