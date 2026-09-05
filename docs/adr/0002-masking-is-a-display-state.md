# Masking is a display state, and its policy and its state live in different places

A screen can be **masked** — every amount replaced by a fixed run of dots — so the app can be opened
in public. The masking *policy* is a household row in `app_setting`; whether a given browser is
masked *right now* is a cookie that browser owns, written by client script and not `HttpOnly`. Both
halves of that split, and the deliberately weak guarantee underneath them, are surprising enough to
be worth writing down.

## The guarantee, stated as a limit

Masking defends against someone reading over your shoulder. It is not access control and must never
be described as though it were: the amounts are still in the page, inside the serialised loader data
the client needs in order to unmask without a round trip. The login gate (§10) is the only boundary
this application has, and anyone who can reach a masked screen can unmask it with one click.

[Only the scenery has moved: that boundary is now a forward-auth gate in front of the application
rather than a login page inside it — ADR-0005. The limit stated here is unchanged, and so is
everything below it.]

[It is no longer the only one: once the household holds a passkey, a browser the gate has already
admitted is refused every screen until an assertion proves it — ADR-0012. The sentence above can no
longer say *only*, and nothing else here moves. Masking still keeps nobody out, is still not access
control, and the amounts are still in the payload of a screen a reader is allowed to see; the lock
decides whether they are allowed to see it, which is the question masking was never asking.]

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
that the gate's is no longer the sole credential-bearing cookie it is being compared against.]

## Considered options

**State in `app_setting` as well.** Coherent, and it matches the Tax tab exactly. Rejected because
setting "start masked" on a phone would silently change the desktop at home, which is the wrong blast
radius for a preference about where you are sitting.

**Omit the amounts from the loader while masked.** A real strengthening — the figures would not be
in the page at all. Rejected because unmasking then costs a round trip, which puts the network back
in the path the client-side write exists to remove, and because it defends against an attacker who
can already click the toggle.

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
