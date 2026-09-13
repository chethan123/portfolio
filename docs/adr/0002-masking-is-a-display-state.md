# Masking is a display state, and its policy and its state live in different places

A screen can be **masked** — every amount replaced by a fixed run of dots — so the app can be opened
in public. The masking *policy* is a household row in `app_setting`; whether a given browser is
masked *right now* is a cookie that browser owns, written by client script and not `HttpOnly`. Both
halves of that split, and the deliberately weak guarantee underneath them, are surprising enough to
be worth writing down.

## The guarantee, stated as a limit

Masking defends against someone reading over your shoulder. It is not access control and must never
be described as though it were: on most screens the amounts are still in the page, inside the
serialised loader data the client needs in order to unmask without a round trip. Anyone who can reach
a masked screen can unmask it with one click.

The forward-auth gate decides which family members may reach the application (ADR-0005). Once the
household holds a passkey, the browser lock decides whether a browser past that gate may see a screen
(ADR-0012). Masking makes neither decision; it changes what an already-admitted, unlocked browser
draws.

**Holdings is a scoped exception.** Its inline correction would otherwise turn those payload values
into exact input defaults without another request. While Holdings is masked, its loader finishes all
filtering, sorting, grouping, totals and ratios on the server, then omits the amount fields from rows,
groups, totals and a saved receipt. It keeps only the non-amount facts needed to draw the masked
screen: whether a value is unknown, coverage counts, ratio strings and gain/loss direction. **Show
amounts** revalidates the route and returns the exact values before the inputs exist. **Hide amounts**
removes open inputs immediately and revalidation replaces their loader data with the omitted form.
This prevents an ordinary masked correction from disclosing exact defaults in markup or client route
state; it does not erase values the browser already received while unmasked.

Root and Holdings resolve masking through one deferred value in React Router's per-request context.
Their loaders start in parallel, so independent policy reads could otherwise disagree during a
concurrent settings write and pair masked chrome with an exact Holdings payload. A failed read fixes
that shared request value to masked rather than allowing a child loader to retry into a different
answer.

Everything below follows from accepting that limit rather than fighting it.

## Why the policy is a row and the state is a cookie

They answer different questions. *What should a browser that nobody has toggled yet open in?* is the
household's answer, and it belongs beside the capital gains rate for the reason §8.4 already gives:
it describes the household rather than the deployment, and the person who wants it changed is the
person reading the screen it produced. *Am I masked at this moment?* is a fact about one browser in
one place — a phone in a queue and a desktop in a locked room want opposite answers, and a single
stored value can only give them one.

The cookie also settles the rendering problem the theme decision (§12) already settled the same way:
the server must know on the first request whether to draw dots, or the page paints the amounts and
then corrects itself, which is the one failure this feature cannot have.

## Why the cookie is written by script, and why it is not `HttpOnly`

The toggle has to work at the speed of a hand, not of a network. On a bad connection a server
round-trip makes the hide button take seconds at the exact moment it is needed, and a purely
optimistic flip whose write then fails would snap the amounts back into view. So the client writes
the cookie itself, and the form `POST` behind the same control remains as the no-JavaScript path and
writes the identical value. One cookie, two writers.

`HttpOnly` is therefore off, which is correct rather than merely convenient: the cookie carries a
display preference, not a credential, and it has to be readable by the script that owns the toggle.
Nothing in it is a secret, and it grants nothing — the only session cookie anywhere is the gate's
(ADR-0005), which the app never issues and which the gate keeps encrypted and `HttpOnly` on its own
side of the boundary (its default; this repo pins only `SameSite` and `Secure`).

[No longer the only one: the app's own grant cookie (ADR-0012) is `HttpOnly` too, and for the same
kind of reason — it carries an opaque id naming one browser's unlock rather than a preference, and
the row that id names is the authority, so nothing about it needs the script access masking's cookie
exists for. That does not make masking's the one cookie
in this stack deliberately not `HttpOnly` — the chart-range preference (`app/lib/chart-range.ts`) is
set the same way, and for the same reason: it too carries a preference rather than a credential. What
actually singles masking's out is the two writers this paragraph opened with: client script sets it
directly, where the chart-range cookie is only ever written by the server. What changed here is only
that the gate's is no longer the only cookie here that carries more than a preference.]

The browser reads that cookie through an external-store subscription. A direct write publishes a
same-tab change event because cookie writes have no browser event of their own. The cookie therefore
remains authoritative after the fetcher stops being pending, including when a toggle request fails
or an older exact Holdings revalidation arrives after a newer Hide. This precedence applies only
when the server successfully resolved the masking policy. A failed policy read is marked in root
loader data and remains masked after hydration even if an older browser cookie says to show. The
server snapshot still comes from the root loader for the first render and hydration; no browser
state is shared between server requests.

## Considered options

**State in `app_setting` as well.** Coherent, and it matches the Tax tab exactly. Rejected because
setting "start masked" on a phone would silently change the desktop at home, which is the wrong blast
radius for a preference about where you are sitting.

**Omit the amounts from every loader while masked.** A real strengthening — the figures would not be
in the page at all. Rejected as the application-wide rule because unmasking then costs a round trip,
which puts the network back in the path the client-side write exists to remove, and because it
defends against an attacker who can already click the toggle. Holdings accepts that round trip for
the narrower correction case above: the alternative made a routine click disclose the exact values
while the control still said they were hidden.

**Blur the rendered text instead of replacing it.** Keeps typography and layout exactly. Rejected
because blurred digits stay selectable, copyable and readable by a screen reader, and at the 32px
net worth headline they are guessable.

## Consequences

- **The dot run is a constant, never sized to the value it replaces.** A mask that preserved digit
  count would leak the magnitude it exists to hide: `$••••••` for twelve dollars and for twelve
  million.
- **Amounts mask; ratios never do.** A weighted yield or an allocation share describes composition
  rather than size. The cost is accepted and stated: anyone who already knows one amount can derive
  others from the percentages.
- **A new browser opens masked**, including one whose policy is *as last left* with nothing left.
  This is the one place safety beat convenience, and it is why the toggle sits in the chrome with a
  text label rather than behind Settings — a first run would otherwise be a page of dots with no
  visible cure.
- **Changing the policy clears the state cookie.** Otherwise the setting appears to do nothing on the
  browser that changed it, and the stale cookie keeps the lifetime the old policy gave it.
- **One component renders every amount.** The guarantee is only as good as its narrowest point, and a
  bare `formatMoney` in a new route would leak silently. There is no linter here, so a test asserts
  the import boundary instead.
