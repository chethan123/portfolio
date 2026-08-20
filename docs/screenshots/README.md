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

DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo npm run dev
```

Then capture each page below at a 1440×1000 viewport, `deviceScaleFactor: 2`, full page, once with
the browser in light and once in dark. The seed reassigns account ids on every run, so read them
back rather than hardcoding: `select id, kind from account`.

| File | Page | Which account |
|---|---|---|
| `overview-*.png` | `/` | — |
| `holdings-*.png` | `/holdings` | — |
| `analysis-*.png` | `/analysis` | — |
| `account-detail-*.png` | `/accounts/:id` | the `brokerage` one — it holds seven positions, including a stale price |
| `account-balance-*.png` | `/accounts/:id` | the `liability` one — it carries the set-balance form |
| `settings-*.png` | `/settings/accounts` | — |
| `overview-mobile-*.png` | `/` | — |
| `analysis-mobile-*.png` | `/analysis` | — |

`holdings-*.png` records a screen that is still a placeholder. It is kept so that the day Holdings
is built, the before is on record — the root README describes that screen in words rather than
showing it, because a screenshot of a stub sells nothing.

Mobile shots (`*-mobile-*.png`) are 390×900, `isMobile`, and **not** full page. The bottom
navigation is `position: fixed`, and a full-page capture paints it across the middle of the image
instead of at the foot of the screen where a phone shows it.

The `AUTH_PASSWORD` banner is left in deliberately. It is what a default instance actually looks
like, and hiding it would make the screenshots show a configuration the reader does not have.

Research screenshots of the *Stitch mock* are a different thing entirely and live in
[`../research/stitch-2026-08/`](../research/stitch-2026-08/).
