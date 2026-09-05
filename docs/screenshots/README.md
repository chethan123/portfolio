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
| `overview-owner-*.png` | `/?owner=:id&range=all` | the first of the demo household's two owners, by id · the owner filter, which is only legible as a difference from `overview-*.png` above: same household, a smaller headline, the owners named beneath it, the long presets greyed out where the household reaches them, and the pre-app line withheld — at **All**, deliberately, because the withheld-history note only appears on a range that would have shown those points unfiltered, and the demo's are years old |
| `overview-1d-*.png` | `/?range=1d` | — · the 1D range, whose time axis, time-of-day readout and one-point-per-refresh granularity are invisible on every other preset |
| `holdings-*.png` | `/holdings` | — · unfiltered and ungrouped, which is the state the URL with no query string produces |
| `holdings-edit-*.png` | `/holdings` with one row open | the brokerage one, on a row that has a cost basis, so both boxes carry a figure. Scoped to the table rather than the page: the point of the shot is the two boxes sitting in their own columns, which a whole-page capture at this width renders too small to read |
| `analysis-*.png` | `/analysis` | — |
| `income-*.png` | `/income` | — · the demo household pays a dividend in all three tax treatments, so the first breakdown shows the three slices rather than the two a household with no Roth would produce |
| `account-detail-*.png` | `/accounts/:id` | the `brokerage` one — it holds seven positions, including a stale price |
| `account-balance-*.png` | `/accounts/:id` | the `liability` one — it carries the set-balance form |
| `settings-*.png` | `/settings/accounts` | — |
| `settings-passkeys-*.png` | `/settings/passkeys` | the capture script's own placeholder passkey (`ensureCapturePasskey`) — enrolled and backup-eligible, so the shot shows a household that has actually turned the lock on, above the add-a-passkey form, never the empty list before anyone has |
| `upload-*.png` | `/upload` | — · the drop screen as it opens: the step strip, the account select, no file chosen and no refusal showing |
| `upload-mapping-*.png` | `/upload/:draftId/columns` | the `brokerage` one · the unfilled first-upload state, with the file's own header and sample rows visible verbatim above the mapping selects |
| `upload-review-*.png` | `/upload/:draftId/review` | the `brokerage` one · **the diff must show a removal listed in full.** The statement is authored against what the account currently holds so all three groups render and the removed row carries its quantity and last known value |
| `overview-mobile-*.png` | `/` | — |
| `analysis-mobile-*.png` | `/analysis` | — |
| `holdings-mobile-*.png` | `/holdings?group=assetClass` | — · the card reflow, the only screen whose layout changes shape below 768px rather than merely narrowing. Grouped, so the group heading, the subtotal strip and the grand total are all in frame |

## The decisions behind them

**Both themes.** GitHub renders these against the reader's own theme, and a light screenshot on a
dark page looks broken. [The guide's images](../guide/images/) have no such constraint and are light
only.

**The desktop shots are 1600 wide, and were 1440.** Holdings is the widest thing the application draws, and it decides this number: with the rail and the canvas margins taken out, 1440 leaves its table about a hundred pixels short, so the last column falls inside the panel's own horizontal scroll and a capture cuts it off. `.data-table-scroll` is the right answer for a narrow window; it is the wrong thing for a README to photograph. The figure to keep these in step with is `--content-max` in the stylesheet — a column added to Holdings is the thing most likely to make both too small again.

**Mobile shots are not full-page.** They are 390×900 with `isMobile`. The bottom navigation is
`position: fixed`, so a full-page capture paints it across the middle of the image instead of at the
foot of the screen where a phone shows it.

**The warning strip is left in deliberately, and it no longer warns about a password.** It is the
application's own notice that nothing in front of it is authenticating anyone, and a capture run is
exactly that state: the script drives a development server with nothing in front of it. The only
ways to take the strip out are to stand the real gate in front of that run — signing a browser in to
Google in order to take a photograph — or to tell the app it is gated when it is not, and both
publish a configuration assembled for the camera. Cropping is not on the table either; these are
never hand-edited. So the images show an ungated instance while the documented deployment is a
gated one, and that is the honest trade: what is photographed is what the code does, with
[the README](../../README.md#who-gets-in-and-where-that-is-decided) carrying what the strip means.

**Its words belong to the application, not to this file**, which is why the strip is a retake
trigger of its own: when the wording changes, every shot carrying it is stale in one commit. That
has already happened once, when the gate replaced the password. Not every shot carries it — a
capture framed on a single table, or below the top of a page, never had it in frame.

**A narrowed screen is shot, and it is shot on Overview.** A control nobody can see in the README is
a feature nobody knows exists, and the owner filter is the one thing on these screens that changes
every figure at once. Overview carries it because it is where the narrowing shows in the most ways at
once: the headline drops, the sentence naming the owners appears under it, a preset greys out as the
reachable history shortens, and the hand-typed prefix stops being drawn — all in one frame, against
an unnarrowed shot of the same screen immediately above it. Holdings would have shown the control
and one shortened table.

**No id is ever written down** — not an account's and not a person's. The seed renumbers both on
every run, so the script looks accounts up by kind and takes the first person by id. A shot
described above as "the brokerage one" means exactly that, and which of the two owners the narrowed
pair is drawn as does not matter: what it has to show is one of them rather than both.

**Income is shot for the README as well as the guide, and it was the guide's alone.** The guide walks every screen, so its loop already visited `/income` while the screen was still a placeholder; the README's theme loop never did, because there was nothing there worth a reader's attention. There is now, and a README that walks the screens with one of them missing reads as though that screen does not exist.

**The upload flow is walked but never committed.** The draft dies with the commit, and recording the
statement would change the household every other shot is of.

Research screenshots of the *Stitch mock* are a different thing entirely and live in
[`../research/stitch-2026-08/`](../research/stitch-2026-08/).
