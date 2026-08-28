# Masking — reading the portfolio in public

Canonical here. Published as [issue #61](https://github.com/chethan123/portfolio/issues/61) so an
agent can pick it up from the tracker; when the two disagree, this file wins.

Vocabulary is `CONTEXT.md`'s: a screen is **masked** when every **amount** is replaced by a fixed run
of dots, a **ratio** is never masked, and the **masking policy** is the household's standing choice
of what an untoggled browser opens in. The decision behind the design is
[`../adr/0002-masking-is-a-display-state.md`](../adr/0002-masking-is-a-display-state.md).

## Problem Statement

The application shows a household's entire financial position on every screen: net worth at 32px on
Overview, every account balance and holding value on Holdings, unrealized gains and a tax estimate on
Analysis, projected dividends on Income. All of it is legible from a metre away.

That is correct at home and wrong everywhere else. Opening the app on a train, in a café, in an
office, or handing a phone to someone to show them a photo means showing anyone nearby exactly how
much money the household has. Today the only options are not opening it or angling the screen.

## Solution

A control in the app's chrome, on every screen, that masks every amount at a click: `$1,248,392.14`
becomes `$••••••`, and stays that way until it is clicked again. Names, symbols, dates, the "as of"
timestamp and every percentage stay exactly as they are, so the screens still say what the portfolio
*is* while refusing to say how much it holds.

The click is instant and needs no network, because the moment it is needed is the moment there may
not be one.

Because a household's answer to "should this start masked?" differs by where they open it, Settings
gains a **Display** tab holding a masking policy with three values: always start masked, always start
unmasked, or open as that browser last left it. A browser nobody has toggled yet is masked.

Masking is a display state and not a security boundary. It defends against being read over the
shoulder; the login gate remains the only thing that keeps anyone out.

_The argument is unchanged, but the gate it names has moved: what keeps anyone out is now a
forward-auth gate in front of the application, not a login page inside it
([0011-auth-gate.md](0011-auth-gate.md),
[ADR-0005](../adr/0005-auth-is-a-forward-auth-gate.md))._

## User Stories

1. As someone checking my portfolio on a train, I want every amount hidden at one click, so that the
   person in the next seat cannot read my net worth.
2. As someone whose screen is about to be seen, I want the click to take effect instantly, so that
   hiding is faster than the person arriving behind me.
3. As someone on a bad mobile connection, I want the hide to work with no network at all, so that
   the feature does not fail in exactly the places I need it.
4. As someone who has hidden the amounts, I want to unhide them just as fast, so that the control is
   not one-way.
5. As someone who is unsure which state I am in, I want the control labelled with what it will do
   rather than what it currently is, so that I do not reveal my balances by clicking the wrong way.
6. As someone using a screen reader, I want a masked figure announced as hidden rather than read as a
   run of bullets, so that the screen still makes sense to me.
7. As someone using a screen reader, I want masking to actually mask for me too, so that a person
   beside me cannot hear my balances.
8. As someone reading a table, I want the columns not to jump when I toggle, so that I do not lose my
   place mid-row.
9. As someone reading Overview, I want the net worth headline masked, so that the largest figure on
   the screen is not the one left visible.
10. As someone reading Overview, I want the trend chart's axis figures masked but its line still
    drawn, so that I can see the shape of the year without publishing the size of it.
11. As someone reading Overview, I want the allocation donut to keep its proportions, so that a
    masked screen still tells me what I am invested in.
12. As someone reading Holdings, I want every value, cost basis, gain and share quantity masked, so
    that a single unmasked column cannot be used to reconstruct the rest.
13. As someone reading Holdings, I want instrument names, symbols and classifications visible while
    masked, so that I can still find the row I am looking for.
14. As someone reading Analysis, I want the unrealized gain figures and the tax estimate masked, so
    that the most sensitive panel is not the one exception.
15. As someone reading Analysis, I want each breakdown's percentages visible, so that the page still
    answers "how am I split" while masked.
16. As someone reading Income, I want projected dividends masked and weighted yield visible, so that
    the page keeps its point without stating my income.
17. As someone reading an account page, I want its balance and performance figures masked, so that
    drilling in does not defeat the toggle.
18. As someone uploading a statement in an office, I want the diff preview masked like everything
    else, so that the largest set of figures in the app is not the one that leaks.
19. As someone correcting a position or typing a balance, I want the field I have opened to show its
    own value, so that I can complete a write I deliberately started.
20. As someone who has opened a form while masked, I want every other figure on the page to stay
    masked, so that opening one field does not unmask the screen.
21. As the person who set this instance up, I want to choose what a browser opens in, so that the
    household is not relying on remembering to click.
22. As someone who mostly reads at home, I want to set the policy to open unmasked, so that I am not
    clicking every single visit.
23. As someone who mostly reads in public, I want to set the policy to open masked, so that I am
    never the one who forgot.
24. As someone with settled habits, I want the policy to be "as I left it", so that each browser
    keeps the state I last chose on it.
25. As someone changing the policy in Settings, I want the change to visibly take effect on the
    browser I am using, so that I can tell it worked.
26. As a member of the household on a new device, I want that device to open masked, so that an
    unfamiliar browser never starts by displaying the balances.
27. As someone who cleared their cookies, I want to be masked again rather than exposed, so that
    losing state fails safe.
28. As someone who has toggled on my phone, I want my desktop at home unaffected, so that a decision
    about where I am sitting does not follow me everywhere.
29. As someone browsing with JavaScript disabled, I want the toggle to still work, so that the
    feature is not the one part of this app that requires it.
30. As someone opening the app fresh while masked, I want the very first paint to be masked, so that
    the amounts are never briefly visible before being hidden.
31. As someone who has hidden the amounts, I want a page navigation to stay hidden, so that moving
    between screens does not undo it.
32. As someone who has hidden the amounts, I want a refresh to stay hidden, so that a reload is not
    an accidental reveal.
33. As someone who set the policy to open masked, I want a fresh browser session to be masked again
    even though I unmasked yesterday, so that "start" means something.
34. As a first-time user of a new instance, I want the control visible on the screen rather than
    buried in Settings, so that a page of dots has an obvious cure.
35. As a developer adding a screen later, I want a leak to fail the test suite, so that this
    guarantee does not quietly decay.
36. As a developer reading the code later, I want one component to be the only thing that renders an
    amount, so that I know where the rule lives.
37. As whoever maintains this, I want the weakness of the guarantee written down, so that nobody
    later mistakes masking for access control.

## Implementation Decisions

**The masking policy is a column on the household's single settings row.** It joins the capital gains
rate for the reason §8.4 gives for that one: it describes the household rather than the deployment.
Three values, and only three. A migration adds the column and seeds it to the masked-on-start value;
the row is already seeded and the single-row rule already holds, so reads stay a
`executeTakeFirstOrThrow` with no default invented in application code. The settings module gains a
reader and a writer beside the existing pair, validated through the same input module rather than a
second copy of the rules.

**The generated types are part of the migration.** A column on `app_setting` means regenerating the
database types and committing them; CI verifies the generated file against a live schema, so a
migration landed without it fails the build rather than drifting quietly.

**Whether a browser is masked right now is a cookie.** Not `HttpOnly` — the toggle's own script
writes it. Its lifetime is decided by the policy: persistent under *as last left*, session-scoped
under either fixed policy, which is what makes "on start" mean "a browser session that has not been
toggled yet" without a timer anywhere.

**Resolution is one pure function**: policy plus the cookie's value, in, masked-or-not, out. An
absent or unrecognised cookie takes the policy's answer, and the policy's answer for *as last left*
with nothing left is masked. This function is the only place the precedence rule is written.

**The root loader resolves it and publishes it.** The first paint is therefore always correct, which
is the same argument §12 makes for the theme cookie and the reason neither is `localStorage`.

**The toggle writes the cookie client-side, and posts.** The click writes the cookie directly, so the
flip costs nothing and survives a dead network; the same control is a form whose action writes the
identical cookie server-side, which is the path with JavaScript off. Both writers share one name,
one value vocabulary and one lifetime rule, which lives with the resolver rather than at either call
site.

**Reading the current state is one hook**, whose answer is the pending submission's value if there is
one and the loader's value otherwise. This is what makes the optimistic flip and the server-rendered
truth the same source as far as every component is concerned.

**One component renders every amount.** It is named for the glossary term, it calls that hook, and it
is the only permitted caller of the money formatters outside the chart. Every route that formats an
amount inline today is converted to it. The formatting module is not touched: it keeps its
string-in-string-out contract and learns nothing about masking, because a display flag in every
signature is how that contract erodes.

**The chart takes the state as a prop**, because its axis ticks and its accessible label are not
components. Its line, its grid and its fill are unchanged — only the figures go.

**The allocation module needs no change at all.** It formats percentages and nothing else, and a
ratio is never masked.

**Masked output is a constant.** The same run of dots regardless of magnitude, with the currency
symbol kept so the cell still reads as money. A signed figure keeps its sign and its direction arrow
and loses only the amount, which preserves the rule that gain and loss are never carried by colour
alone. Amount cells carry a fixed minimum width so that toggling moves nothing.

**Masked figures are announced, not spelled.** The dots are hidden from assistive technology and the
cell carries an accessible label saying an amount is hidden; the column header continues to supply
what kind of amount it was.

**Coverage is every read-only figure on every screen**, including the upload diff preview. A form
input that has been deliberately opened shows its own value, because a masked input cannot be typed
into.

**The control lives in the chrome** — the desktop rail and the phone's top bar — with an icon *and*
text, labelled with the action it will perform rather than the state it is in. No keyboard shortcut.

**Settings gains a Display tab** holding the policy, which also gives the theme choice a home when
§12's toggle lands. Saving the policy clears the state cookie, so the change takes effect on the
browser that made it and the stale lifetime goes with it.

**§8.4's tab table and §12 both need editing.** The design record gains a row and a cross-reference;
this is a design change, not only a code change.

## Testing Decisions

A good test here asserts what a person would see, not how it was produced. The claim this feature
makes is "no amount is on this screen", and that claim is only meaningful at the point where a whole
screen exists — so the render is the seam, and the components underneath it are not tested
separately. A test that renders the amount component and finds dots proves that dots render; it says
nothing about every other file that has to route through it, which is where the feature actually
fails.

**One behavioural seam: the route.** Loaders, actions and full renders driven exactly as the existing
route tests drive them — a `Request` in, and either the returned data or static markup out. The
shared request helper gains an optional cookie, which is the one piece of new scaffolding. What is
pinned there:

- A masked render of Overview, Holdings and the upload diff contains no amount, in any of the forms
  the formatters produce, and does contain the ratios, names and dates that must survive.
- An unmasked render of the same screens contains them.
- The first paint is masked when the cookie says so, with no unmasked figure anywhere in the markup.
- The toggle action responds with a cookie whose lifetime matches the policy in force.
- Saving the policy clears the state cookie.
- A masked amount is announced as hidden and its dots are hidden from assistive technology.

Prior art for all of it: the route tests already call loaders directly and render through the routes
stub, and the component tests already assert over static markup.

**One pure test: the resolver.** Three policies against cookie present, absent and unrecognised, as a
table. Exhausting nine cases through database-backed renders would be slow and would prove less;
this is the domain rule, and `AGENTS.md` asks for domain rules to be tested as themselves. Prior art:
the existing pure-module tests.

**One structural test: the import boundary.** It fails when a money formatter is imported anywhere
outside the amount component and the chart. This repo has no linter, so the suite is where this rule
can live. It is a test about file layout and will need updating when files move — accepted
deliberately, because the leak it catches is silent, ships happily, and is noticed only by the person
it was supposed to protect.

**The settings module's own tests** gain the policy beside the capital gains rate: the three valid
values stored and read back, and a refusal for anything else, driven against a real database like the
existing pair.

Not tested: that the client-side cookie write happens in a browser. There is no browser in the suite,
and the server-side path writes the same value and is pinned above.

## Out of Scope

- **Any strengthening of the guarantee.** The amounts remain in the page while masked. Stripping them
  from the payload is a different feature with a different cost and is argued against in the ADR.
- **A keyboard shortcut**, a long-press menu, or any second entry point to the toggle.
- **Auto-masking** on idle, on blur, on tab switch or on any timer.
- **Per-person or per-account masking.** There is one household and one state.
- **Masking anything that is not an amount** — names, institutions, symbols, dates and ratios all stay
  visible, and the ADR records what that concedes.
- **The theme toggle.** The Display tab is built with room for it; §12's work is not part of this.
- **Any change to the login gate**, the session cookie, or the deployment's configuration surface.
- **Masking in the PWA manifest, the page title, or browser chrome.**

## Further Notes

**One thing must be grounded before code is written.** The optimistic-flip mechanism depends on the
router exposing a pending submission's form data to the component that submitted it. That is how it
is expected to work, but it could not be verified while this was written: dependencies are not
installed in the authoring environment and the router's documentation site is unreachable from it.
Confirm it against React Router 7.18's own documentation first. If it does not hold, the fallback is
a single piece of component state holding the optimistic value — which costs this application its
"no client state" property, and is worth a conversation rather than a quiet substitution.

**The default is the one place safety beat convenience.** A household that opens this at home every
day will meet a page of dots on every new browser, and the argument for that was not obvious: the
counter-case, that a privacy feature should be opt-in on a machine that is usually private, was
considered and overruled deliberately. The consequence to watch for is a first run that looks broken;
the visible, text-labelled control in the chrome is the mitigation, and it is the reason the control
cannot move into Settings later without revisiting this.

**Ratios are a deliberate hole.** Anyone who knows one amount can recover others from the
percentages. Closing it would take the ratios too, and would leave the screens saying almost nothing
while masked.
