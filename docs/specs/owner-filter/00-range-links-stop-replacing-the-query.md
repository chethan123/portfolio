# 00 — Range links stop replacing the whole query

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** `ChartRangeControl`'s preset links preserve the rest of the query string instead
of replacing it.

This is a live bug on a shipped screen, and it is separable from everything else in this slice.
`app/components/chart-range-control.tsx:103` links to a bare ``to={`?range=${option.key}`}``, which
React Router resolves as *replace the whole query*. Today that silently drops the account screen's
`?uploaded=` and `?recorded=` receipts: upload a statement, land on the receipt, click 1M, and the
confirmation you were reading disappears. Tomorrow it would drop the owner filter on Overview.

It is listed first because it blocks the filter's correctness and is worth landing on its own — one
file, one test, reviewable in a couple of minutes, and it makes ticket 03 meaningfully smaller. It
carries no part of the filter and could have been filed as a bug without this slice existing.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The fix**

- [ ] A preset link keeps every search param except the ones it owns, replacing only `range` and —
      when moving off a custom span — clearing `start` and `end`
- [ ] The disabled-preset branch is untouched: still a `<span aria-disabled="true">`, never a link
      (`app/components/chart-range-control.tsx:92-98`)
- [ ] The custom-range `<form method="get">` (`:54-88`) likewise carries the other params through, as
      hidden fields, so applying a custom span does not drop them
- [ ] `preventScrollReset` and `aria-current` behaviour are unchanged
- [ ] The default preset keeps whatever behaviour the header comment at `:16-20` describes — it
      deliberately stopped linking to `.` because the cookie would win, and that reasoning still holds

**Tests** (`tests/routes/account.test.ts`)

- [ ] Clicking a range preset on `/accounts/:id?uploaded=<setId>` preserves `uploaded`, and the
      receipt is still rendered — the reproducing case for the bug
- [ ] The same for `?recorded=`
- [ ] Moving from a custom span to a preset clears `start` and `end`
- [ ] A preset link on a screen with no other params still produces exactly `?range=<key>`
