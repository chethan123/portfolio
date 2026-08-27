# Chart interaction is pre-rendered markup revealed by CSS, not client state

Adding a per-point readout to the net worth trend line is the first feature in this application that
is genuinely *pointer* state: not a URL, not a form, not something that can be bookmarked, reloaded
or sent to the other person in the household. Every interaction shipped so far has been one of
those. `app/routes/holdings.tsx` states the resulting property outright — the application has no
React state anywhere — while arguing that a filter bar is not the place to start; a hover readout is
the much more persuasive place to start, which is why the answer belongs here rather than in another
route's comment.

We render the interaction instead of computing it. For each plotted point the chart emits an
invisible full-height hit target, a vertical guide line, and that point's own readout text, grouped
together; one CSS rule reveals the guide and the text on `:hover` and `:focus-within`. The points are
already discrete coordinates in an abstract drawing box, so there is nothing to measure at runtime
and nothing to recompute on resize. The output is correct in the server-rendered HTML, works with
JavaScript disabled, and adds no hydration surface. The cost is three extra elements per point,
bounded by the sampling budget ADR-0003 introduced.

The general rule this sets: an interaction whose states are finite and known at render time is
rendered, not computed. Client state is reserved for interactions that are not — and reaching for it
means revisiting this record, because the property being protected is not "this component is
cheap", it is "this application has no hydration story to maintain".

## Considered options

**One `useState` and a `pointermove` handler**, snapping to the nearest point by x. The conventional
answer, and the one most reviewers would expect. Rejected: it makes the chart a client component,
leaves the readout dead until hydration, and — the actual cost — spends the codebase-wide property
for a single widget. There is no version of this where the second such feature is refused on
principle after the first was accepted.

**A tooltip element positioned from the cursor.** Rejected with the mechanism above, and separately
on geometry: the drawing box is stretched with a non-uniform aspect ratio, which is already why the
end-of-line marker is an HTML element rather than an SVG circle, so a tooltip would need the same
workaround while also covering the line it describes.

**Rendering the readout beside the page's headline figure**, which is where it reads best. Rejected
as a *mechanism* rather than as a placement: the hit targets are inside the chart's `<svg>` and the
headline is in a different section, so a CSS-only reveal across that boundary needs one generated
rule per sample point — up to a hundred and eighty rules in a `<style>` tag. Placing the readout at
the top of the chart panel puts it in almost the same visual position for one rule.

## Consequences

- The chart's element count grows by roughly a factor of three, bounded by ADR-0003's sample budget.
  Raising that budget now has a markup cost as well as a query cost.
- Keyboard users get no per-point interaction. The targets are focusable but deliberately outside
  the tab order, because the alternative is up to a hundred and eighty tab stops in the middle of a
  page; the chart's existing single text description is what serves assistive technology.
- The groups are HTML overlays positioned in percentages, not SVG children. Implementation found
  the SVG variant impossible on the geometry option two already names: the drawing box is stretched
  non-uniformly, which a stroke survives (`non-scaling-stroke`) and rendered text does not, and the
  readout text has to live inside the hovered group for the reveal to stay one rule. This is the
  end-of-line marker's workaround applied to the whole interaction; the invisible target, the guide
  and the caption per point, and the single-rule reveal on `:hover`/`:focus-within`, are unchanged.
- Touch support depends on tap-to-focus of a non-tabbable element — HTML now, which also retires
  the open question this record used to carry about SVG focus in Safari: tap focusing an element
  with a `tabindex` holds across current Chrome, Firefox and Safari. Where it ever does not, the
  feature degrades to its resting state rather than breaking.
- Any future chart interaction — brushing, zooming, a range drag — will not fit this pattern, since
  its states are not finite at render time. That is the point at which this record should be
  reopened rather than worked around.
