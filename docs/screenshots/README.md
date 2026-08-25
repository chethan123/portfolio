# Screenshots

The images [`README.md`](../../README.md) shows. Every one is the real application against the
generated demo household — never a mock, and never hand-edited.

They are committed rather than generated on demand because a README has to render on GitHub for
someone who has not installed anything. That makes them the one thing in this repository that can
silently go stale: **a change to a screen is not finished until these are retaken.**

## Retaking them

[`../../scripts/capture-screenshots.ts`](../../scripts/capture-screenshots.ts) retakes all of them,
along with [the guide's](../guide/images/). Its header carries the commands and the mechanics.

This file carries what the script cannot: which shot is of what, and why.

## Which shot is of what

| File | Page | Which account, and why |
|---|---|---|
| `overview-*.png` | `/` | — |
| `holdings-*.png` | `/holdings` | — · unfiltered and ungrouped, which is the state the URL with no query string produces |
| `holdings-edit-*.png` | `/holdings` with one row open | the brokerage one, on a row that has a cost basis, so both boxes carry a figure. Scoped to the table rather than the page: the point of the shot is the two boxes sitting in their own columns, which a whole-page capture at this width renders too small to read |
| `analysis-*.png` | `/analysis` | — |
| `income-*.png` | `/income` | — · the demo household pays a dividend in all three tax treatments, so the first breakdown shows the three slices rather than the two a household with no Roth would produce |
| `account-detail-*.png` | `/accounts/:id` | the `brokerage` one — it holds seven positions, including a stale price |
| `account-balance-*.png` | `/accounts/:id` | the `liability` one — it carries the set-balance form |
| `settings-*.png` | `/settings/accounts` | — |
| `upload-*.png` | `/upload` | — · the drop screen as it opens: the step strip, the account select, no file chosen and no refusal showing |
| `upload-mapping-*.png` | `/upload/:draftId/columns` | the `brokerage` one · the unfilled first-upload state, with the file's own header and sample rows visible verbatim above the mapping selects |
| `upload-review-*.png` | `/upload/:draftId/review` | the `brokerage` one · **the diff must show a removal listed in full.** The statement is authored against what the account currently holds so all three groups render and the removed row carries its quantity and last known value |
| `overview-mobile-*.png` | `/` | — |
| `analysis-mobile-*.png` | `/analysis` | — |

## The decisions behind them

**Both themes.** GitHub renders these against the reader's own theme, and a light screenshot on a
dark page looks broken. [The guide's images](../guide/images/) have no such constraint and are light
only.

**The desktop shots are 1600 wide, and were 1440.** Holdings is the widest thing the application draws, and it decides this number: with the rail and the canvas margins taken out, 1440 leaves its table about a hundred pixels short, so the last column falls inside the panel's own horizontal scroll and a capture cuts it off. `.data-table-scroll` is the right answer for a narrow window; it is the wrong thing for a README to photograph. The figure to keep these in step with is `--content-max` in the stylesheet — a column added to Holdings is the thing most likely to make both too small again.

**Mobile shots are not full-page.** They are 390×900 with `isMobile`. The bottom navigation is
`position: fixed`, so a full-page capture paints it across the middle of the image instead of at the
foot of the screen where a phone shows it.

**The `AUTH_PASSWORD` banner is left in deliberately.** It is what a default instance actually looks
like, and hiding it would make the screenshots show a configuration the reader does not have.

**Account ids are never written down.** The seed renumbers accounts on every run, so the script
looks them up by kind. A shot described above as "the brokerage one" means exactly that.

**Income is shot for the README as well as the guide, and it was the guide's alone.** The guide walks every screen, so its loop already visited `/income` while the screen was still a placeholder; the README's theme loop never did, because there was nothing there worth a reader's attention. There is now, and a README that walks the screens with one of them missing reads as though that screen does not exist.

**The upload flow is walked but never committed.** The draft dies with the commit, and recording the
statement would change the household every other shot is of.

Research screenshots of the *Stitch mock* are a different thing entirely and live in
[`../research/stitch-2026-08/`](../research/stitch-2026-08/).
