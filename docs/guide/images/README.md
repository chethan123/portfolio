# The guide's images

Every image the [guide](../) shows. Like [the README's](../../screenshots/), each is the real
application against the generated demo household in
[`../../../scripts/seed-demo.ts`](../../../scripts/seed-demo.ts) — never a mock, never hand-edited.

Retake them with [`../../../scripts/capture-screenshots.ts`](../../../scripts/capture-screenshots.ts),
which holds the mechanics. This file holds the decisions the script cannot.

## Light only, and why that is honest here

The README's images ship in both themes because GitHub renders them against a reader's chosen theme
and a mismatched screenshot looks broken. The guide has no such problem, so every image here is
light, and the guide says so once rather than doubling a set that already has to be kept current.

The application follows your system's setting and has no in-app toggle, so a reader on a dark system
sees a darker version of the same screen — same layout, same words, same figures.

## The no-password banner stays in

The yellow banner across the top of most shots is what an instance with no password actually looks
like. Cropping it would show the reader a configuration they may not have, and the guide's first
page explains it.

## Two databases

Most shots are of the seeded demo household. The three `first-run-*` images cannot be — they are of
an instance with nothing in it, which is a state the demo database is by definition not in. They
come from a second database, migrated and left unseeded, which is why the capture script takes a
`--first-run` pass with its own `DATABASE_URL`.

## The upload shots are of a real draft, never a commit

The four `upload-*` images are captured by driving the actual four-step flow with a statement
generated from what the demo brokerage account currently holds. The walk stops at the review screen:
recording would destroy the draft, and would change the household every other image is of.

The statement is generated at capture time rather than committed alongside these images. The demo
calendar is built from the wall clock, so quantities drift with the day the database was seeded — a
CSV frozen today would slowly turn its unchanged rows into changed ones, and `upload-4-review.png`
would stop showing the diff it is captioned as showing.

## Sizes

Desktop shots are 1440×1000 at `deviceScaleFactor: 2`, full page. `overview-mobile.png` is 390×900,
`isMobile`, and **not** full page: the bottom navigation is `position: fixed`, so a full-page capture
paints it across the middle of the image instead of at the foot of the screen where a phone shows it.

`holdings-edit.png` is scoped to the table rather than the page. At this width a whole-page capture
renders the two open boxes too small to read, and the point of that image is the boxes sitting in
their own columns.
