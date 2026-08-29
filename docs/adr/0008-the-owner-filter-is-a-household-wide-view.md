# The owner filter is a household-wide view, not an identity

Every screen that shows money can be narrowed to one or more **owners** — read the Overview as
Alice, the Analysis as the two children, the Holdings table as either. The filter is one selection
shared by the whole instance, carried from screen to screen, and it is never derived from who signed
in. Each half of that is the opposite of what a reader would assume from the feature's name, and
undoing either later means touching every money screen at once.

## Why it is not the signed-in person

The obvious design is the wrong one here, and it will be proposed again. The gate already knows a
verified email address on every request (ADR-0005); defaulting the filter to that person looks like
a free courtesy.

It is not free. `CONTEXT.md` says of the authenticated email that *it may say who did a thing, and
it never decides what anyone may do*, and `app/root.tsx` says the same at the one place the header
arrives. A filter that opens on you is a filter whose default is computed from an identity, and the
distance from there to "and this is your data" is one feature request. This household holds shared
money: an account is one person's for the purpose of saying whose it is, not for the purpose of
keeping anyone out.

The mapping does not exist either, and inventing it is the actual cost. `person` is a name and
nothing else — no email column, no link to the allowlist — because a person is a label for whose
money it is, not a user account. Defaulting by identity means a person-to-address join, an answer
for a family member with no accounts, an answer for two people sharing a login, and an answer for an
address on the allowlist that names nobody. All of that, so that one family member saves one click.

So the filter is a chooser: anybody may set it, clear it, and set it to anybody. It opens on the
whole household, which is the only default that needs no identity to compute.

## Why it is one selection rather than one per screen

Narrowing to a person is not a property of a screen; it is a question the reader is holding while
they move between screens. Choosing the children on Analysis and finding Holdings back at four
people makes the reader do the filing the app should be doing.

The cost is a real one and is paid deliberately: a filter that survives navigation can be forgotten,
and the number it silently redefines is the Overview headline. Two things keep that honest.

**The URL is the whole of the state.** There is no cookie and nothing stored. The filter travels
between screens because the navigation links carry **the owner param** — not the whole query string,
which would drag one screen's sort or half-typed correction onto another. `NAVIGATION` in
`app/root.tsx:115-120` is bare paths today, and bare paths are why a `NavLink` drops the query. So
the filter lasts exactly as long as the URL does: close the tab and the household is back, not
because a cookie lifetime was chosen well but because there is nothing left to remember it. A link
pasted to another family member carries the same view, which a cookie could never do.

The rejected alternative was a session cookie written by a route middleware, mirroring the chart
range. It would have survived a hand-typed path, and cost an encoder, a decoder, a third copy of the
cookie-header reader, a middleware on four routes, and a rule for a selection that had gone stale
while the app was not looking. For a filter whose whole job is to be visible, storing it invisibly
was the wrong trade.

**And every screen reading a narrowed figure states the owners in words** beside the figure, never
as a highlighted chip alone.

Two costs come with holding the state only in the address, and both are accepted rather than hidden.
A hand-typed path or an old bookmark starts unfiltered. And any excursion to a screen the filter does
not reach — Settings, the upload flow — ends the reading: those links deliberately do not carry the
param, so there is no filtered way back and the filter must be set again. For a filter whose job is
to answer one question and then get out of the way, ending when the question does is the right
behaviour, not a defect.

## Why the hand-typed history disappears under it

This half was decided before the filter existed. DESIGN.md §7's third rule already says that only
the total chart reaches back, that a view grouped by person starts at day zero because the manual
series has no structure to slice, and that the UI says so rather than showing a suspiciously short
line. What is new is that a filter, not only a grouping, now puts a screen into that case.

`manual_networth` is a date and an amount — the household's pre-app net worth, entered before there
were accounts to attribute it to. There is no owner on it and no honest way to invent one. With the
filter on, that series is therefore not drawn, and the Overview chart begins where the selected
owners' recorded positions begin. This makes the filter a third chart surface alongside the
household and the account: like an account, and unlike the household, it cannot reach behind the
first recorded position set, so **All** shortens and the longer presets may fall out of reach.

The alternative that looks harmless — leave the old line in place — draws household history running
into one person's present as a single continuous line. That is the failure this codebase avoids
everywhere else: a figure that is wrong in a way nobody can see.

## Considered options

**Default the filter to the signed-in family member.** Rejected above: it converts attribution into
a default, and buys a person-to-address mapping the schema deliberately does not have.

**A filter per screen, in each screen's own query string.** Simpler, and nothing persists to be
forgotten. Rejected because the reader's question persists even when the app's state does not, and
because a rule that every future money screen offers the filter is then a convention somebody has to
remember rather than an argument the readers already require.

**A session cookie written by a route middleware**, mirroring the chart range exactly. Rejected in
favour of the navigation carrying the search: the cookie's one advantage is surviving a hand-typed
path, and its costs are an encoder, a decoder, a third copy of the cookie-header reader, a middleware
mounted on four routes, and a rule for a selection that went stale unobserved. A filter whose whole
job is to be visible should not be stored invisibly.

**A stored household preference, in `app_setting` beside the masking policy.** Rejected because it
is the wrong blast radius, for the reason ADR-0002 gives about masking state: one person narrowing
to the children on a phone would narrow the desktop in the next room. The filter describes a reading
in progress, not the household.

**Apportion the pre-app history by today's ownership share.** Rejected because it manufactures a
per-person past out of a present ratio — numbers nobody recorded, indistinguishable on screen from
numbers somebody did.

## Consequences

- **Household-scoped readers take the filter and require it; account-scoped readers do not take it
  at all.** A required argument with no default does not make honouring the filter impossible to
  skip — a new screen can pass `ALL_OWNERS` and draw no control. What it buys is that the skip is
  **visible in review** rather than invisible by omission, which is the most a signature can do. The same trick, for the same reason, as the chart's required `masked` prop.
- **An account's own screen ignores the filter and does not draw the control.** It is already
  narrowed to one account, and one account has exactly one owner; a filter with a single value to
  offer is not drawn, which is the rule the Holdings filter bar already follows.
- **Selecting every owner is spelled the same as selecting none — the filter off.** One view has one
  URL, so `?owner=` naming the whole household normalises away rather than becoming a second
  spelling of the unfiltered screen.
- **An id that names nobody narrows to nothing, and says so.** One rule, whatever carried it. The
  alternative considered — drop it and show the household — was rejected because widening a view
  somebody asked to narrow is the failure `holdings-view.ts:399-407` already names, and because a
  selection can only go stale within one browser session, which is not long enough to be worth a
  second rule.
- **Every breakdown narrows, including the one grouped by owner.** Filtering to one owner leaves that
  panel with a single slice at 100%, which is honest and useless; it was left in rather than special-
  cased, because two owners selected is exactly the split a reader wants beside a combined total.
