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
  feature degrades to its resting state rather than breaking. **Superseded by the amendment below**: tap-to-focus works, and pinning is not the gesture a touch screen asks for.
- Any future chart interaction — brushing, zooming, a range drag — will not fit this pattern, since
  its states are not finite at render time. That is the point at which this record should be
  reopened rather than worked around. **Amended below**: scrubbing was misfiled here — its
  states are finite, and what it lacks is a selector, not a state model. Brushing and zooming
  still stand outside this pattern.

---

## Amendment: the pointer may be tracked imperatively, but the states stay rendered

The touch consequence above is wrong about what it solved. Tap-to-focus does pin a readout, and it
does hold across current browsers — but pinning was never the gesture a phone asks for. The
expected interaction on a trend line is a finger dragged along it with the guide following, and this
record shipped a feature that answers the first touch and then ignores the hand. On the primary
device for this application that is the whole interaction, not an edge of it.

**The limit was never finiteness.** The last consequence above files a range drag with brushing and
zooming, as an interaction "whose states are not finite at render time". Scrubbing is not one of
those. Its states are exactly the states already in the DOM — one guide and one caption per plotted
point, tiled midpoint to midpoint by `hitTargets`. What is missing is not a state model; it is a
*selector*. `:hover` has no touch equivalent that tracks movement: a touch pointer takes implicit
pointer capture at `pointerdown`, so every `pointermove` in the gesture is dispatched to the tile
the finger landed on, and the emulated hover state never moves either. `:focus-within` fires once,
in the same place, for the same reason. Brushing and zooming remain outside this pattern. Scrubbing
was misfiled with them.

So the amendment is narrow, and it is a distinction rather than a reversal: **rendering the states
and selecting among them are separate decisions.** The states stay pre-rendered, exactly as argued
above. Where no CSS selector exists for the input device, the selection may be driven imperatively
by a plain script. What is still refused is client *state* — there is no model here, and the script
holds nothing: the selection lives in the DOM, as it already did.

### The mechanism

`app/lib/chart-scrub.ts`, imported by `root.tsx` for its side effect and guarded on
`typeof document !== "undefined"` — the guard `masking-toggle.tsx` already uses for its optimistic
cookie write. One delegated listener on `document`, so it survives client navigations and needs no
per-page wiring and no ref.

Four things make it small enough to be worth having:

- **It moves focus. It does not invent a state.** The hit targets already carry `tabIndex={-1}`,
  put there by this record so that a tap could pin a readout, and `app.css` already reveals a
  focused tile's guide and caption and already yields the resting strip to it. So the script calls
  `tile.focus({ preventScroll: true })` and stops. **It adds no CSS selector and no new concept** —
  it makes the pin mechanism that is already here follow the finger. Pinning after the lift, and
  releasing when a press lands elsewhere, are then the browser's focus behaviour rather than rules
  of ours; nothing has to clear anything, and nothing can go stale across a re-render.
- **It asks the browser which tile, rather than being told.** `document.elementFromPoint(clientX,
  clientY).closest(".chart-hit")`. Implicit capture rules out `event.target`, and the alternative —
  shipping the target boundaries to the client and searching them again — would make `hitTargets`
  the second implementation of the tiling instead of the only one. The DOM already holds the index;
  the script only queries it. This is also what keeps "nothing to measure at runtime, nothing to
  recompute on resize" true: no `getBoundingClientRect`, no resize listener, no geometry in JS.
- **It ignores the mouse entirely.** `:hover` is already right for a pointer that hovers, and a
  second mechanism over the same tiles could only disagree with it. Touch and pen only.
- **It skips the call when the tile has not changed**, so a drag across the plot is a handful of
  focus moves rather than one per frame.

`.chart-hits` takes `touch-action: pan-y` and `user-select: none` — the two CSS declarations this
amendment does add. Without the first the browser claims the horizontal drag as a pan and cancels
the pointer stream mid-gesture; `pan-y` rather than `none` so a finger landing on the chart can
still scroll the page.

### Consequences

- **Horizontal gestures over the chart are spent.** `pan-y` is what makes scrubbing possible and it
  forecloses swipe-between-ranges, and the browser's edge back-swipe wherever the plane reaches the
  screen edge. This is the real price, and it is paid in the layout rather than in the script.
- **The touch interaction is dead until hydration**, where the CSS one was correct in the first
  paint. It degrades to tap-to-pin rather than to nothing: with JavaScript off the chart behaves
  exactly as it did before this amendment, which is why none of the existing rules move.
- **`tabIndex={-1}` becomes load-bearing twice over.** This record justified it as "focusable so a
  tap can pin a readout, without becoming one of up to 180 tab stops"; it is now also the whole of
  the scrub mechanism. Removing it, or making the tiles tabbable, breaks two features rather than
  one, and the comment at the call site should say so.
- **Focus moves during a drag.** `document.activeElement` walks the plot while a finger is down.
  The plane is `aria-hidden`, so assistive technology does not follow it, and nothing in this
  application watches focus — but that is a property of today's code, not a guarantee.
- **`elementFromPoint` runs at pointer rate.** A document hit test per move event, on the main
  thread. Bounded and cheap at this document's size; it is not nothing.
- **This is the first imperative client code inside `app/`.** `public/sw.js` (ADR-0007) is the only
  comparable thing and it lives outside the application entirely. The precedent this sets is the
  one stated above — a selector, not a state model — and it should be quoted back at the next
  change that claims it.
- **Masking is untouched.** No formatter reaches the browser: every readout was formatted on the
  server under the masking cookie, and the script only chooses which of them shows.
  `masking-boundary.test.ts` needs no new entry, and the fact that it needs none is the check that
  this stayed a selector.
- **`ARCHITECTURE.md`'s "there is no React state anywhere in the application" stays true**, as does
  the property this record exists to protect. Nothing becomes a client component, the chart's
  rendered output is unchanged, and the module takes no part in reconciliation.

### Considered and rejected

**Leave it as tap-to-pin.** Free, and honest about the constraint. Rejected on use: the application
is read on a phone, and the chart is the screen it is read for.

**A `data-active` attribute with its own CSS rules**, set and cleared by the script. This was the
first draft, and it is the mistake this repository warns about: a second selection mechanism
sitting beside `:focus-within`, needing its own reveal rules, its own clearing rule for the press
that lands elsewhere, and its own answer for a pin surviving into a re-render with a different
number of tiles. Every one of those questions is already answered by focus.

**`public/chart-scrub.js`, loaded with a script tag**, on ADR-0007's argument — hand-written, no
build step, verified by reading one short file. Rejected because that argument turns on the worker
needing to exist before the bundle does. Nothing here does, and the cost is real: a file in
`public/` is outside `tsc`, and `npm run typecheck` is this repo's gate.

**A single guide element positioned from the pointer, with the caption written by the script.** The
conventional tooltip, and smaller markup. Rejected on the boundary: writing the caption means
formatting money in the browser, or copying text out of the DOM to avoid formatting it — the first
breaks `masking-boundary.test.ts`'s guarantee, and the second is a worse way to reach text that is
already in the right place.
