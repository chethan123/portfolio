# A chart point readout — the trend line says what each point is worth, and when

Canonical here. Published to the tracker so an agent can pick it up from there; when the two
disagree, this file wins.

See [ADR-0004](../adr/0004-pre-rendered-chart-interaction.md) for why the interaction is
pre-rendered markup revealed by CSS rather than client state, and
[ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md) for the sampling this readout has to
sit on top of.

## Problem Statement

The trend line on the Overview and on an account page shows the shape of a period without ever
saying what any point in it is worth. The axis names three values, rounded to a compact form
(`208.0K`), positioned against rules the eye has to interpolate between; the x axis names three
dates. Everything else on the line is unlabelled. Someone looking at a dip in March cannot find out
what the dip was, and someone looking at the far left of an "All" range cannot tell whether the
figure there is a real valuation or one of the hand-typed points from before the app existed —
the dash says so, but a dash is easy to miss and impossible to read a number off.

There is a second, quieter problem in the same place. The Overview tells a screen reader that the
line ends at the household's *current* net worth. That is only true when the selected range ends
today. On a custom range ending last month, the line ends at last month's value and the announced
figure is today's — a wrong number, stated confidently, to the one reader who has no way to check it
against the picture.

## Solution

Each chart gains a **readout**: a single line of text at the top of the chart panel body, directly
under the headline figure on both screens. At rest it captions the last point the line actually
plots — its date and its value. Pointing at the chart moves the readout to the nearest point and
draws a vertical guide line there, so the text says *what* and the guide says *which*.

The value is stated at full precision, the same formatting the headline figure uses, so when a
range does end today the readout and the headline agree digit for digit. A point that came from the
hand-typed pre-app series says so in words, because a dashed stroke is a claim about provenance that
text rendered identically would quietly undo.

The interaction is entirely pre-rendered markup and CSS: there is no client-side JavaScript, no
React state, and the readout is correct in the server-rendered HTML before anything hydrates. On a
touch screen a tap pins the readout without adding anything to the page's tab order. On a masked
screen the amount becomes the same run of dots every other masked figure uses and the interaction
keeps working, because masking is a display state rather than a mode.

The accessible label stops being told what the line ends at and starts deriving it from the last
point plotted, which makes it true on every range.

## User Stories

1. As someone looking at my net worth trend, I want to point at any part of the line and read what
   it was worth, so that I can investigate a dip or a spike instead of guessing at it from the axis.
2. As someone looking at the trend, I want the date of the point I am pointing at, so that I know
   which day the figure belongs to — the points are not evenly spaced, so position alone does not
   tell me.
3. As someone who has not touched the chart yet, I want the readout to already say something useful,
   so that the strip is not a blank row waiting for an interaction I may never perform.
4. As someone on a phone, where there is no hover at all, I want the resting readout to name the
   most recent point, so that the feature is not simply absent on the device I read this on most.
5. As someone on a phone viewing a short range, I want to tap a point and have its value stay on
   screen, so that I can read it without a pointer.
6. As someone tabbing through a page with the keyboard, I want the chart not to become a hundred and
   eighty tab stops between the range control and the next link, so that the page stays navigable.
7. As someone reading the Overview, I want the readout to sit under the headline net worth figure,
   so that the number I am investigating appears where my eye already is.
8. As someone reading an account page, I want the same readout in the same relative place under that
   account's total value, so that the two screens do not behave differently.
9. As someone comparing the readout with the headline on a range that ends today, I want the two
   figures formatted identically, so that their agreement is legible rather than something I have to
   verify digit by digit.
10. As someone viewing a custom range that ends in the past, I want the resting readout to name the
    value at the end of *that* range, so that the chart tells me about the period I asked for rather
    than about today.
11. As someone viewing the Overview over a long range, I want a point that came from the hand-typed
    pre-app series to be marked as hand-typed in the readout, so that I do not read a rough annual
    figure as a priced valuation.
12. As someone viewing an account page, I want no hand-typed marks ever to appear, so that the
    absence of a pre-app series for a single account is not implied to be present.
13. As someone pointing between two plotted points, I want the nearest point selected rather than
    nothing at all, so that the chart responds everywhere rather than only on invisible targets.
14. As someone pointing at the sparse left-hand side of a long range, I want the wide region between
    two distant old points to still resolve to the nearer of them, so that half the chart is not
    inert.
15. As someone with the screen masked in public, I want the readout's amount replaced by the same
    run of dots as every other amount, so that the feature does not become the one place a figure
    survives masking.
16. As someone with the screen masked, I want the date to remain visible, so that a date — which is
    not an amount — is not hidden for no reason.
17. As someone with the screen masked, I want pointing at the chart to still respond, so that
    masking changes what a screen shows rather than what it does.
18. As someone using a screen reader on the Overview, I want the line's description to name the
    value the line actually ends at, so that a custom range ending in the past is not announced with
    today's figure.
19. As someone using a screen reader, I want the readout strip excluded from the accessibility tree,
    so that a hundred and eighty hidden alternates are not read out as stray sentences.
20. As someone using a screen reader, I want the date of the final point included in the line's
    description, so that hiding the visible strip does not lose information I would otherwise have.
21. As someone browsing with JavaScript disabled, I want the readout to work, so that the feature
    matches the rest of an application that already works without it.
22. As someone on a slow connection, I want the readout correct in the first HTML response, so that
    there is no window in which it is blank or wrong.
23. As someone switching between chart ranges, I want the readout to reflect the new range
    immediately, so that it never describes a point from a range I have left.
24. As someone viewing a chart with too few points to draw a line, I want no readout strip at all,
    so that an empty caption does not appear beside the note explaining why the line is missing.
25. As someone viewing a portfolio that has not moved, I want the readout to work on a perfectly flat
    line, so that the degenerate case does not break the feature.
26. As someone whose theme is dark, I want the guide line and the readout to follow the theme, so
    that the chart does not acquire a light-themed element in a dark page.
27. As a developer reading this later, I want the reason the interaction is pre-rendered rather than
    stateful written down as a decision, so that a future pass does not "simplify" it into a
    hydrated component and quietly end this application's no-client-state property.
28. As a developer, I want the geometry that decides which point a position selects exposed as a
    pure function, so that it can be tested without a DOM or a browser.
29. As a developer, I want the hand-typed mark tested as a rule about output, so that the §7
    distinction cannot regress into two identically-worded readouts.
30. As a developer, I want the masked readout tested, so that the file already named by the masking
    import boundary cannot start rendering a real amount in a new place.
31. As a developer, I want a reproducing test for the wrong accessible label, so that the bug this
    spec fixes has a case that fails without the fix.
32. As a developer, I want the routes to lose a prop rather than gain one, so that the fix removes
    the opportunity for the two call sites to disagree again.
33. As someone naming this concept later, I want the distinction between current net worth and the
    value a range ends at recorded in the glossary, so that the next person to conflate them has
    somewhere to have been told.

## Implementation Decisions

**The readout is a strip at the top of the chart panel body, on both screens.** On the Overview that
places it under the `Total net worth` KPI figure; on an account page, under that account's total
value. One placement, one component, one rule. It was chosen over putting the text inside the
headline block: the hit targets live inside the chart's `<svg>` and the headline lives in a
different section, so a CSS-only reveal across that boundary needs one generated rule per sample
point. It was also chosen over a tooltip pinned to the cursor, which would cover the line it
describes and would need the same percentage-positioning workaround the existing end-of-line marker
already needs, because the drawing box is stretched non-uniformly.

**The interaction is pre-rendered markup revealed by CSS. No client state.** For each plotted point
the chart emits a group containing an invisible full-height hit target, a vertical guide line, and
that point's own readout text; a single CSS rule reveals the guide and the text on `:hover` and on
`:focus-within` within the group. The sample count is bounded by the existing sampling budget, so
the node count is bounded with it. This is recorded as ADR-0004 because it sets a precedent beyond
this component: it is the answer to "may an interactive feature introduce React state", and the
answer so far in this codebase has been no, currently asserted only in a comment in an unrelated
route.

**Hit targets tile the plot from midpoint to midpoint.** Each point's target runs from halfway to
its left neighbour to halfway to its right, with the first and last extending to the edges of the
box. This gives full coverage with no dead regions and no overlaps, and it means a position selects
the nearest point — which is what pointing at a place on a line means. Sampling is geometric, so
targets vary enormously in width; a fixed width would leave most of a long range inert, and equal
widths would decouple the target from the point beneath it. A consequence worth stating: on the
Overview a hand-typed annual point can own a target months wide. That is honest — it is the nearest
thing known — and story 11's mark is what stops it reading as a daily valuation.

**Targets are focusable but not tabbable.** They carry a tabindex that permits focus without
entering the tab order, so a tap can pin a readout while the keyboard tab sequence is untouched. The
chart already carries a role and a full text description for assistive technology, so per-point
focus would add noise rather than access. Whether tap-to-focus on a non-tabbable SVG element holds
on iOS Safari is the one open question; if it does not, touch degrades to the resting readout and
nothing else about this spec changes.

**The readout states a date and an amount.** The amount uses the full-precision money formatter,
identical to the headline. A compact form was rejected as a blurrier copy of the axis tick, and
whole dollars were rejected because the resting readout and the headline are the same number when
the range ends today, and formatting them differently would make an agreement read as a
discrepancy. The date always carries its year, unlike the x-axis ticks, which drop it on spans under
about six months — an axis tick is read in the context of two others, and a readout is read alone.

**No change figure in the readout.** Stating a hovered point's movement against the range start
means subtracting two decimal strings inside a component. An account page already refused a delta
chip on exactly those grounds. This component is permitted to format money; it is not permitted to
do arithmetic on it.

**Hand-typed points are marked in the readout.** The pre-app series is dashed precisely so it is
never blended into the computed line. A readout that worded both series identically would undo that
in the medium a reader is actually looking at. Account pages pass an empty pre-app series, so the
mark can never appear there.

**Masking dots the amount and leaves the interaction alone.** A masked screen replaces every amount
with the shared constant; a date is not an amount and stays. The hit targets, guide and reveal are
unchanged. Suppressing the interaction when masked would make masking a functional mode rather than
a display state, which contradicts ADR-0002 — and it would buy nothing, since the amounts are in the
serialised page either way, an accepted limit that ADR already states.

**The strip is excluded from the accessibility tree,** joining the axis labels and the x ticks,
which are already excluded on the stated grounds that the line's text description carries the chart
for anyone who cannot see it. The hidden alternates are hidden by a mechanism that removes them from
the tree rather than merely making them invisible.

**The chart derives its own ending figure; the prop that supplied it is deleted.** The line's text
description currently ends with a figure passed in by the caller. The Overview passes the
household's current net worth, which is wrong whenever the range ends before today; the account page
passes its last computed point, which is right. The component already computes that same last point
in order to place the end-of-line marker, so the prop is redundant as well as dangerous, and the
correct fix removes it rather than correcting one of its two call sites. The description gains the
final point's date alongside its value, which is what story 20 asks for once the visible strip is
hidden.

**Geometry is exposed as a pure function.** The mapping from a plotted series and a scale to a list
of hit targets — each with its horizontal extent, its point, and whether that point is hand-typed —
is exported alongside the existing scale and grid-rule functions, so it is testable without a DOM.

**Colours resolve through classes, never through presentation attributes.** The guide line reuses
the mechanism the existing grid rules use — a class, a custom property, and a non-scaling stroke —
so a theme change re-colours it with nothing to re-resolve, and the stretch of the drawing box does
not thicken it.

**No new module.** The change is confined to the chart component, its stylesheet, and the removal of
one prop at two call sites.

**Glossary.** `CONTEXT.md` gains one term for the value a plotted range ends at, distinguished from
current net worth. The readout itself gets no glossary entry: it is a widget, and that file holds no
implementation detail.

## Testing Decisions

A good test here asserts output a reader could be misled by, not the shape of the code that produced
it. The existing chart test file states this in its own words: the risk is not that the chart fails
to draw, it is that it draws something plausible and wrong. All four tests below belong in that file,
which already exercises the module's pure functions directly and pays for a server render only where
the rule is genuinely about markup — the same split applies here.

**The seam is the chart component's module boundary, and it is the only one.** The existing test
file already imports that module's exported functions and renders the component with React's static
server renderer. Every rule in this spec is reachable from there: the new geometry function is pure,
and provenance, masking and the text description are all visible in static markup. The routes are
not a seam for this work — they lose a prop and gain nothing.

Four tests:

1. **Target geometry.** Against a series with deliberately uneven spacing, the targets tile the full
   width of the drawing box with no gap and no overlap, and each boundary sits at the midpoint
   between its two points. Pure function, no render.
2. **Provenance.** In a rendered chart with both series, the readout belonging to a hand-typed point
   carries the mark and the readout belonging to a computed point does not.
3. **Masking.** In a rendered masked chart, every readout carries the shared masked constant and no
   readout contains a currency figure. This complements rather than duplicates the existing
   import-boundary test, which polices which files may call a money formatter but not what they
   render when masked.
4. **The description.** A chart whose points end before today describes the line as ending at the
   final plotted point's value and date — the reproducing case for the bug, failing without the fix.

Not tested: that CSS `:hover` reveals an element. That needs a browser runner this repository does
not have, and what it would assert is that the platform works. The iOS focus question is answered by
checking current browser documentation during implementation, not by a test to maintain forever.

## Out of Scope

- Any change to which dates are sampled, to the range presets, or to how a range is chosen.
- A movement or percentage figure in the readout.
- Per-point focus for keyboard users, or any change to the chart's existing single text description
  beyond the ending value and date.
- A readout on the allocation breakdown chart, which is a different visualisation with different
  semantics.
- Any change to the end-of-line marker, which stays where it is and keeps its current behaviour.
- Making the chart interactive in any way that requires client-side JavaScript, now or as a
  follow-up, without revisiting ADR-0004.
- Adding a per-account pre-app series so that account charts could carry hand-typed points.

## Further Notes

The two problems in this spec share one root cause: nothing in the codebase had a name or a value
for "the point this line actually ends at". The Overview reached for current net worth because that
was the value to hand. Fixing the readout and fixing the description are therefore one change, and
splitting them would mean introducing the correct value and then not using it.

The node cost is worth stating plainly rather than discovering in review: the chart emits three
extra elements per plotted point, against a sampling budget that caps the point count. That is the
price of the property ADR-0004 records, and it is the reason the decision is worth writing down
rather than leaving as a surprise in a diff.
