# 0020 — The lock, hardened before its first household

> Triage label to apply when each ticket is filed: `ready-for-agent`
>
> Read [the launch review](../research/2026-09-05-lock-slice-launch-review.md) first. It is the
> evidence under every ticket here — each finding it names is reproduced there, with the lines and
> the command — and this spec does not restate the reproductions. Spec [0019](0019-the-lock.md) and
> [ADR-0012](../adr/0012-a-browser-past-the-gate-is-shown-nothing.md) stay authoritative for the
> lock's design; nothing here changes what the lock is, only what stands between it and a
> household relying on it.

**Status:** proposed · **Slice directory:** [`lock-hardening/`](lock-hardening/) · **ADR:** none —
no decision here is hard to reverse · **Vocabulary:** unchanged; `CONTEXT.md`'s `Locked` and
`Passkey` carry the whole of it

## Problem Statement

The lock slice (0019) merged on 2026-09-05 with every ticket's checklist met in code and 1708
tests green, and a launch review the same day found no way past the refusal and no way to mint a
grant without a verified assertion. It also found what a green suite could not see: the unlock
screen is an open redirect at the moment of authentication; the two wirings the whole feature
rests on — the framework flag that makes root middleware run at all, and the two halves of the
first-enrolment race — can each be removed with every test still passing; "Lock now" ends the
grant the cookie names and leaves the browser's earlier ones live; a registration is stored as the
client sent it, empty credential id included; and the family guide describes screens the code does
not draw. None of it is a hole in the lock. All of it is what a household would meet first.

The review's verdict was *ship with conditions*. This spec is the conditions, and the rest of its
plan, as tickets an agent can take one at a time.

## Decisions

Two kinds. The first was taken by the owner and is recorded here so no ticket reopens it. The
second is this spec's own, and merging the spec is what approves it.

**Taken by the owner, 2026-09-05**

- **`/healthz.data` stays as it is.** The review's F2 — that a single-fetch request for the exempt
  health path runs the root loader and serialises setup state for a browser holding no grant — is
  kept deliberately: the request is behind the gate, the fields are setup state and never a
  figure, and the exemption's shape is not worth a second rule. Ticket
  [08](lock-hardening/08-bring-the-documents-level.md) corrects the comment in `app/root.tsx` that
  calls the data form harmless *because no data is served*, so the code records the decision
  rather than a false reason for it. No ticket changes the behaviour.

**Made by this spec**

- **A tab hydrated hidden keeps counting as hidden.** The review's F10 (a background tab opened
  with Cmd-click locks the browser the first time it is shown after a minute) is kept: it fails
  toward locking, which is the direction spec 0019's story 3 asks for, and the cost is one unlock
  prompt. Ticket 05 tells the family; ticket 08 says so beside the code that does it. No code
  changes.
- **The third bootstrap interleaving is stated, not closed.** The review's F11 is one statement
  wide in production, needs an insider holding a stale bootstrap challenge, and the two ways to
  close it — a mirror predicate on the ordinary insert, or a table lock inside a transaction —
  each cost more than the window is worth (ticket 09 says exactly what each costs). The migration's
  claim that two mechanisms are sufficient is corrected instead.
- **The order is the review's, minus the one the owner struck.** Tickets 01–05 and 07 — with the
  real-device walk 07 writes — land before the household's first passkey is enrolled; 06 and 08–11
  may follow it.

## Solution

Eleven tickets, one pull request each except 11, which is two. They fall into four kinds, and the
kind decides how a reviewer should read the diff:

**Close what is open** — [01](lock-hardening/01-close-the-open-redirect.md) the redirect,
[03](lock-hardening/03-one-live-grant-per-browser.md) the orphaned grants,
[04](lock-hardening/04-narrow-what-registration-stores.md) the unvalidated registration,
[10](lock-hardening/10-refuse-a-cross-origin-post.md) the unchecked resource-route mutation. Each
changes one function's behaviour and is judged by the test that would have been red before it.

**Pin what is right** — [02](lock-hardening/02-pin-the-wiring.md). No behaviour changes; the
suite gains the tests the review's mutation pass showed it lacks, so that the next person who
flips the middleware flag or drops `where not exists` finds out from CI.

**Say what is true** — [05](lock-hardening/05-say-what-the-family-will-see.md) the family guide
and its neighbours, [06](lock-hardening/06-name-a-cloned-authenticator.md) one refusal message,
[07](lock-hardening/07-hedge-cross-device-and-walk-it.md) the one promise that depends on a
browser, [08](lock-hardening/08-bring-the-documents-level.md) every other sentence and comment the
review found describing something the code does not do,
[09](lock-hardening/09-state-the-third-interleaving.md) the one argument in a migration comment
that over-claims.

**The small ones** — [11](lock-hardening/11-the-small-ones.md), two pull requests of nits that
share nothing but their size.

### What every ticket inherits

- The review's finding numbers (`F1`…`F16`) are cited by ticket so the reproduction is one click
  away; a ticket never re-argues a finding, it acts on it or says why it does not.
- House rules apply unchanged: `withDatabase`, the fixture builders, full-sentence `it` names,
  exact strings, no `any`, Zod only in the domain module, routes translating and never ruling
  (CLAUDE.md). A ticket that needs a rule states it in `app/lib/lock.server.ts` and nowhere else.
- Fewer, sharper tests (AGENTS.md): a ticket asks for the test that turns a named regression red,
  and not for a route test that restates a pure rule already pinned.
- Every ticket ends with the three gates — `npm run typecheck`, `npm run build`, `npm test` against
  the throwaway Postgres — and names which single test files prove its own change, so a reviewer
  can run those first.
- A ticket that changes a screen retakes the screenshots with `scripts/capture-screenshots.ts`
  (docs/README.md and docs/developing.md both make that the definition of finished). 05 retakes
  the Settings → Passkeys set; 07 and 11(a) retake only if their own change moves a captured
  layout, and say which.

## Testing

The review's mutation pass is the yardstick: nineteen breaks, fifteen red, two near-equivalent,
two survived — dropping `where not exists` from the bootstrap insert and writing `bootstrap =
false` in it — plus, outside the nineteen, a `Domain=` attribute nothing refused and two removal
checks that went red only through a message regex. After ticket 02 each of those is a named box
with a test behind it. The drive script under
[`harness/`](../research/2026-09-05-lock-slice-launch-review/harness/) is the manual check for the
one wiring the suite cannot reach — `Layout`'s effect — and ticket 02 says so rather than
pretending a DOM-less suite proves it.

## Out of Scope

- **Any change to what the lock is** — the idle window, the grace, the bootstrap rule, the
  exempt list. 0019 owns those.
- **`/healthz.data`** — decided, above.
- **A browser-driven test suite.** The suite is deliberately DOM-less (CLAUDE.md, "Tests"); the one
  wiring that needs a browser is checked by the drive script, by hand, and ticket 02 records the
  gap.
- **The gate's own cookie lifetime and sign-out** — 0019 already declines them, and the review's F9
  (a sign-in bounce mid-absence defeats the automatic lock for at most one idle window) is told to
  the family in 05 rather than fixed.
- **Real-device verification by an agent.** Ticket 07 writes the walk an operator performs and the
  copy that holds until it is performed; no agent can perform it.

## Tickets

- [`lock-hardening/01-close-the-open-redirect.md`](lock-hardening/01-close-the-open-redirect.md)
- [`lock-hardening/02-pin-the-wiring.md`](lock-hardening/02-pin-the-wiring.md)
- [`lock-hardening/03-one-live-grant-per-browser.md`](lock-hardening/03-one-live-grant-per-browser.md)
- [`lock-hardening/04-narrow-what-registration-stores.md`](lock-hardening/04-narrow-what-registration-stores.md)
- [`lock-hardening/05-say-what-the-family-will-see.md`](lock-hardening/05-say-what-the-family-will-see.md)
- [`lock-hardening/06-name-a-cloned-authenticator.md`](lock-hardening/06-name-a-cloned-authenticator.md)
- [`lock-hardening/07-hedge-cross-device-and-walk-it.md`](lock-hardening/07-hedge-cross-device-and-walk-it.md)
- [`lock-hardening/08-bring-the-documents-level.md`](lock-hardening/08-bring-the-documents-level.md)
- [`lock-hardening/09-state-the-third-interleaving.md`](lock-hardening/09-state-the-third-interleaving.md)
- [`lock-hardening/10-refuse-a-cross-origin-post.md`](lock-hardening/10-refuse-a-cross-origin-post.md)
- [`lock-hardening/11-the-small-ones.md`](lock-hardening/11-the-small-ones.md)

**Blocked-by graph**, so several can run at once. Start on nothing: 01, 02, 03, 04, 07, 10.
Then: 05 after 07 (07 edits one guide paragraph; 05 edits the rest, and is larger); 06 after 03
(adjacent lines in `verifyScopedAssertion`); 09 after 04 (both edit `completeRegistration`'s
header); 11(a) after 05 (05 writes the interim guide sentence 11(a) removes, and 07 — before 05 —
edits the `<strong>` in the same JSX block 11(a) adds a control to); 11(b) after 11(a) (one import
line in `passkeys.tsx`); 08 after 02, 05, 10 and 11(a) (comments in `root.tsx` that 02 and 10
touch, the guide 05 and 11(a) touch). The remaining pairs that edit one file do so in different
regions — 03 and 07 in `passkeys.tsx` (the action versus the acknowledgement JSX); six tickets in
`app/lib/lock.server.ts` and five in `tests/lock.test.ts`, all additive — and a ticket branching
from the latest `main` after its blockers merge will not conflict.
