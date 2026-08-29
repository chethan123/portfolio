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

## `holdings-owner.png` is the owner filter's only picture

The owner filter narrows four screens, and [its guide page](../owner-filter.md) is illustrated once,
on Holdings. Holdings is where the control is easiest to read against something familiar — it is the
same table `holdings.png` already shows unnarrowed — and it is the screen whose panel header spells
the narrowing out in words as well as in figures. The README's pair is on Overview instead, for the
opposite reason: [there](../../screenshots/README.md) the point is everything a narrowed chart does
differently, which needs a before and an after to be visible at all.

`holdings-grouped.png` was narrowed as well as grouped until this shot existed, which left the
reader working out which of two controls had done which. It is grouped and nothing else now, and
the narrowing is here.

## Sizes

Desktop shots are 1600×1000 at `deviceScaleFactor: 2`, full page. `overview-mobile.png` is 390×900,
`isMobile`, and **not** full page: the bottom navigation is `position: fixed`, so a full-page capture
paints it across the middle of the image instead of at the foot of the screen where a phone shows it.

`holdings-edit.png` is scoped to the table rather than the page. At this width a whole-page capture
renders the two open boxes too small to read, and the point of that image is the boxes sitting in
their own columns.
