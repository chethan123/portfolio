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

## Almost every shot has a phone companion, and the lock screen is shot for the first time

Almost every screenshot in this guide now has a `*-mobile.png` beside it. `overview-mobile.png` used
to be the only one; the rest of the guide's screens have since caught up to what its own "On a
phone" section already did. The one deliberate exception is `upload-2-columns-blank.png`: the six
mapping selects it is captioned as showing sit below the fold on a phone in both the blank and the
mapped state, so a `upload-2-columns-blank-mobile.png` would be pixel-for-pixel indistinguishable
from `upload-2-columns-mapped-mobile.png` and was not kept.

The locked screen is new here too: `unlock.png` and `unlock-mobile.png` are the first shots of it
this guide has ever had. Every other shot in this file is of an already-unlocked browser; these two
are the one deliberate exception — the capture script plants a real passkey and then visits
`/unlock` carrying none of the grant every other pass mints for itself, so what renders is the
actual locked screen a household would see, not a mock of one. Both are framed on the card alone
rather than the page around it, because there is no page around it — no header, no navigation,
nothing behind **Unlock** to draw.

## The warning strip stays in, and it is no longer about a password

The yellow strip across the top of most shots is the application warning that nothing in front of it
is authenticating anyone — which is precisely what a capture run is, since the script drives a
development server with no gate. Removing it would mean either running the real gate to take a
photograph, which puts a Google sign-in between the script and every screen, or telling the app it
is gated when it is not. Both photograph a configuration that exists only for the camera, and
cropping is out because nothing here is hand-edited.

The reader the guide is written for will not see the strip on a deployment set up as documented, so
[the guide's first page](../first-run.md) says what it means and who removes it. The wording is the
application's own, so a change to it makes every shot carrying the strip stale at once — that has
happened once already, when the gate replaced the password. Shots framed on a single table or below
the top of a page never had it in frame and are unaffected.

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

## The owner filter is shot on Holdings

`holdings-owner.png` is the same table `holdings.png` shows unnarrowed, which is what makes the
control legible; the README's pair is on Overview, for [its own reasons](../../screenshots/README.md).
`holdings-grouped.png` was narrowed as well as grouped until this shot existed, leaving the reader to
work out which of two controls had done which; it is grouped and nothing else now.

## Sizes

Desktop shots are 1600×1000 at `deviceScaleFactor: 2`, full page. Every `*-mobile.png` is 390×900,
`isMobile`, and **not** full page: the bottom navigation is `position: fixed`, so a full-page capture
paints it across the middle of the image instead of at the foot of the screen where a phone shows
it. That is the limit `overview-mobile.png` accepted first, and every mobile shot since carries it —
one screenful, at whatever scroll position that shot calls for (the top of the page, most of the
time; scrolled to the row or form the shot is actually of, a few times), never the whole page at
once.

`holdings-edit.png` is scoped to the table rather than the page. At this width a whole-page capture
renders the two open boxes too small to read, and the point of that image is the boxes sitting in
their own columns.
