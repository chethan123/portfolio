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
  feature degrades to its resting state rather than breaking. **Amended below**: this is right,
  and it is not the whole gesture — pinning answers the first touch and then ignores the hand.
- Any future chart interaction — brushing, zooming, a range drag — will not fit this pattern, since
  its states are not finite at render time. That is the point at which this record should be
  reopened rather than worked around. **Amended below**: this holds for all three, a range drag
  being a span selection. Scrubbing is not one of them and was never considered here; what it
  lacks is a selector, not a state model.

---

## Amendment: the pointer may be tracked imperatively, but the states stay rendered

The touch consequence above is not wrong, it is incomplete. Tap-to-focus does pin a readout, it does
hold across current browsers, and spec 0010's story 5 asks for exactly that. What neither this
record nor that spec asked is whether pinning is the *whole* gesture, and on a trend line it is not:
the expected interaction is a finger dragged along the line with the guide following it. The chart
answers the first touch and then ignores the hand. On the primary device for this application that
is most of the interaction, not an edge of it.

**Scrubbing was never considered here, rather than considered and refused.** The last consequence
above rules out "brushing, zooming, a range drag" as interactions "whose states are not finite at
render time". That is right about all three — a range drag there means selecting a span, which is
brushing's sibling. Scrubbing is a different animal and simply never came up. Its states are exactly
the states already in the DOM: one guide and one caption per plotted point, tiled midpoint to
midpoint by `hitTargets`. Nothing about it needs a state model. What it needs is a *selector*, and
no CSS one exists for a finger:

- A direct-manipulation pointer takes implicit pointer capture at `pointerdown` — Pointer Events
  Level 3 makes this a SHOULD, for touch *and* pen — so every `pointermove` in the gesture is
  dispatched to the tile the finger landed on. `touchmove` reaches the same place by a different
  route: Touch Events Level 2 requires the target to stay the element the touch started on.
- Emulated `:hover` does not track the finger either. Selectors Level 4 declines to specify
  hit-testing at all, so this is de-facto behaviour and it diverges: Chrome and Firefox on Android
  clear the state at touch-end, while WebKit leaves it applied until something else is tapped
  (WebKit 158517).
- `:focus-within` fires once, at the landing tile, for the capture reason above.

So the amendment is narrow, and it is a distinction rather than a reversal: **rendering the states
and selecting among them are separate decisions.** The states stay pre-rendered, exactly as argued
above. Where no CSS selector exists for the input device, the selection may be driven imperatively
by a plain script. What is still refused is client *state*: there is no model here and the script
holds no data — only a mark on whichever tile the finger is over.

### The mechanism

`app/lib/chart-scrub.ts`, imported by `root.tsx` for its side effect and guarded on
`typeof document !== "undefined"`. Listeners are delegated to `document` — `pointerdown`,
`pointermove`, `pointerup`, `pointercancel` — so they survive client navigations and need no ref and
no per-page wiring. Touch and pen only: `:hover` is already right for a pointer that hovers, and a
second mechanism over the same tiles could only disagree with it.

Three choices are forced rather than preferred, and the record is mostly here to say why.

**The mark is `data-scrub-active`, an attribute React never renders.** React's DOM reconciliation
only visits keys present in the previous or next props, so an attribute it never rendered is never
touched — true of the implementation, though react.dev states only the weaker principle ("you can
safely modify parts of the DOM that React has no reason to update"). A *class* would not be safe
for the same reason: `className` is written wholesale with `setAttribute("class", …)`, so any
re-render that changes the string deletes an externally added class with it.

**The tile is found with `document.elementFromPoint(clientX, clientY)`, mapped back with
`.closest(".chart-hit")`.** Implicit capture means `event.target` is useless, and the documented
escape — `releasePointerCapture` in the `pointerdown` handler, which would restore native
retargeting and make this a one-liner — is not available: WebKit does not implement releasing an
implicit capture (WebKit 199803), and iPhones are the device this is for. Per-move hit testing is
the only route there. It is also what keeps this record's "nothing to measure at runtime, nothing to
recompute on resize" true, and it leaves `hitTargets` the single implementation of the tiling rather
than shipping the boundaries to the client to be searched again. `clientX`/`clientY` are the right
coordinate space, `pointer-events: none` elements are skipped (so the guide and the marker are
transparent to it), capture does not affect it — and it returns `null` outside the viewport, which
under capture is reachable and must be handled.

**The stylesheet has to change, and this is not a free rider on the existing rules.** The reveal
rules at `app.css:1300`–`1317` guard the focus path with `.chart-hits:not(:has(:hover))`, so on
WebKit a sticky hover left on the landing tile would suppress every other tile for the rest of the
gesture and beyond. The hover reveal moves inside `@media (hover: hover)`, taking its guard with it;
the focus reveal stands unguarded outside it, which is what keeps tap-to-pin working with JavaScript
off. `data-scrub-active` gets the same pair of rules as `:focus-within`. `.chart-hits` takes
`user-select: none` and `touch-action: pan-y pinch-zoom` — `pan-y` is the spec's own worked example
for this exact case, and `pinch-zoom` has to be spelled out or the declaration silently removes
zoom, which is an accessibility cost and not one worth paying for a guide line.

### Consequences

- **Horizontal drags over the chart no longer scroll the page.** That is the point of `pan-y`, and
  it forecloses any future swipe-between-ranges over the plot. A steeply diagonal or vertical drag
  is still claimed for scrolling and still ends the stream with `pointercancel`, which is the
  behaviour we want: a finger landing on the chart can still scroll the page.
- **The touch interaction is dead until the module executes**, where the CSS one is correct in the
  first paint. It degrades to tap-to-pin rather than to nothing — that is why the focus rules stay,
  and the reason to check with JavaScript off after touching this.
- **Nothing tests it.** `vitest.config.ts` sets `environment: "node"` and the house rule is no
  DOM (CLAUDE.md); `net-worth-chart.test.tsx` asserts fragments of `renderToStaticMarkup` output.
  No test in this suite can dispatch a `pointermove` or call `elementFromPoint`, so `tsc` is the
  only gate this module passes and every claim above is verified by hand on a phone. The rejection
  of `public/chart-scrub.js` below rests on `tsc`; it should be read knowing `tsc` is all there is.
- **Two mechanisms now select a point, and only convention keeps them apart.** The script ignoring
  the mouse, and the hover rules being scoped to `@media (hover: hover)`, are what stop a
  double-caption. Nothing enforces either.
- **`elementFromPoint` runs at pointer rate.** Roughly the cost of the browser's own hit test, but
  it flushes style and layout — so the handler must read before it writes, or it pays an extra
  layout per move. Fast drags will also skip tiles between frames, since a UA may coalesce
  `pointermove`; harmless here, because the question asked is only "which point is under the finger
  now", never "which points were crossed".
- **`DESIGN.md` §13.6 and `docs/specs/0010-chart-point-readout.md` both state that the interaction
  is CSS with no client-side JavaScript.** Both become false and must be corrected in the same
  commit as the code. Story 21 of that spec — the readout working with JavaScript disabled —
  survives, at tap-to-pin.
- **Masking is untouched.** No formatter reaches the browser: every readout was formatted on the
  server under the masking cookie, and the script only chooses which of them shows. So
  `masking-boundary.test.ts` needs no new entry — though note that test polices formatter *imports*,
  not the boundary's spirit, and would not have caught the tooltip variant rejected below.
- **`ARCHITECTURE.md`'s "there is no React state anywhere in the application" stays true.** Nothing
  becomes a client component, the chart's rendered output is unchanged, and the module takes no part
  in reconciliation.

### Considered and rejected

**Leave it as tap-to-pin.** Free, and honest about the constraint. Rejected on use: this application
is read on a phone, and the chart is the screen it is read for.

**Move focus instead of marking an attribute** — `tile.focus({ preventScroll: true })`, reusing the
`tabIndex={-1}` this record already put on the targets and the reveal rules already in the
stylesheet, so that pinning and clearing fall out of browser focus behaviour. This was the drafted
mechanism and it is the one to argue for, which is why it is recorded in full. It dies twice.
`preventScroll` is unimplemented on Chrome for Android (crbug 41453122) and unreliable on iOS
(WebKit 236584), so `focus()` may scroll the plot out from under the finger — the precise failure
being fixed. And `.chart-hits` is `aria-hidden`, so driving focus into it at pointer rate turns an
occasional ARIA violation into a continuous one. Focus into a hidden subtree is a defect this
record already carries for tap-to-pin; it is not a foundation to build on.

**`releasePointerCapture` in `pointerdown`**, restoring native retargeting so `event.target` tracks
the finger and no hit testing is needed. Strictly better where it works, and it does not work on
WebKit (199803).

**`pointerrawupdate` instead of `pointermove`.** Unsupported in Safari, and the wrong tool anyway:
it reduces latency, not spatial accuracy.

**Scope the hover rules to `@media (hover: hover)` and stop there**, with no script at all. This is
required either way and is part of the mechanism above, but it is not an alternative to it: it
unblocks the focus path without giving anything a reason to move.

**A `data-scrub-active` attribute was the first draft, then replaced by the focus mechanism, then
restored.** The reversal is recorded because the argument for focus was good and still lost: reusing
an existing mechanism is the right instinct, and it was beaten by two platform facts that no amount
of reading this repository would surface.

**`public/chart-scrub.js`, loaded with a script tag.** The service worker is in `public/` because a
worker needs an origin-root URL for its scope, not for any reason that transfers here; ADR-0007's
actual argument is auditability, which this file gets either way. Rejected on the gate: `tsconfig`
covers `.ts`/`.tsx` with no `allowJs`, and given the consequence above that `tsc` is the only gate
this module has, putting it outside `tsc` leaves none.

**A single guide element positioned from the pointer, with the caption written by the script.** The
conventional tooltip, and much less markup. Rejected on the boundary: writing the caption means
formatting money in the browser, or copying text out of the DOM to avoid formatting it — the first
breaks `masking-boundary.test.ts`'s guarantee, and the second is a worse way to reach text that is
already in the right place.

### Precedent, stated accurately

This is not the first imperative client code in `app/` — `root.tsx` already ships an inline
`<script>` to register the service worker, and `masking-toggle.tsx` already writes `document.cookie`
behind a `typeof document` guard. It is the first that is neither a one-liner nor attached to a
specific element, and the first module whose whole job is browser behaviour. The rule it sets is the
one above — a selector, not a state model — and it should be quoted back at the next change that
claims it.
