# Screenshots

The images [`README.md`](../../README.md) shows. Every one is the real application against the
generated demo household — never a mock, and never hand-edited.

They are committed rather than generated on demand because a README has to render on GitHub for
someone who has not installed anything. That makes them the one thing in this repository that can
silently go stale: **a change to a screen is not finished until these are retaken.**

## Retaking them

```sh
printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo\n' > .env.demo
node --env-file=.env.demo ./server/migrate.ts
node --env-file=.env.demo ./scripts/seed-demo.ts

DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo \
  PRICE_POLL_INTERVAL_MINUTES=1440 npm run dev   # see the note below
```

Then capture each page below at a 1440×1000 viewport, `deviceScaleFactor: 2`, full page, once with
the browser in light and once in dark. The seed reassigns account ids on every run, so read them
back rather than hardcoding: `select id, kind from account`.

| File | Page | Which account |
|---|---|---|
| `overview-*.png` | `/` | — |
| `holdings-*.png` | `/holdings?group=assetClass` | — · grouped, because grouping and its subtotals are half of what that screen is for and the ungrouped table is the same rows without them |
| `analysis-*.png` | `/analysis` | — |
| `account-detail-*.png` | `/accounts/:id` | the `brokerage` one — it holds seven positions, including a stale price |
| `account-balance-*.png` | `/accounts/:id` | the `liability` one — it carries the set-balance form |
| `settings-*.png` | `/settings/accounts` | — |
| `overview-mobile-*.png` | `/` | — |
| `analysis-mobile-*.png` | `/analysis` | — |
| `holdings-mobile-*.png` | `/holdings?group=assetClass` | — · scrolled so the first group heading sits under the top bar, since the subject is the card reflow and the filter bar is above it |

Mobile shots (`*-mobile-*.png`) are 390×900, `isMobile`, and **not** full page. The bottom
navigation is `position: fixed`, and a full-page capture paints it across the middle of the image
instead of at the foot of the screen where a phone shows it. One consequence: a shot whose subject
is below the fold has to be scrolled to before the capture, which is why the Holdings one is.

**Turn the price poller off before you shoot**, with `PRICE_POLL_INTERVAL_MINUTES=1440`. It runs
inside the app process, and on a machine that cannot reach the price provider — a sandbox, a CI
runner, an aeroplane — the first tick marks every quote stale exactly as it is designed to. The
screenshots then show a portfolio where everything reads "price is stale", which is a true picture
of that machine and a false one of the demo: the seed puts exactly one stale price and one
never-priced holding in, and those two are the point. Re-seed if a shoot has already staled them.

The `AUTH_PASSWORD` banner is left in deliberately. It is what a default instance actually looks
like, and hiding it would make the screenshots show a configuration the reader does not have.

Research screenshots of the *Stitch mock* are a different thing entirely and live in
[`../research/stitch-2026-08/`](../research/stitch-2026-08/).
