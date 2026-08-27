# 02 — Correct spec 0008's now-superseded sampling claims

Part of [0009-dynamic-chart-resolution.md](../0009-dynamic-chart-resolution.md). Published as
[issue #75](https://github.com/chethan123/portfolio/issues/75); when the two disagree, this file
wins.

**What to build:** A documentation-only fix. `docs/specs/0008-chart-ranges.md` states, in its
Implementation Decisions, "**Sampling is unchanged.** The existing fixed 25-sample,
deduped-by-calendar-day approach is reused as-is for every preset, including Custom, regardless of
span length — no new bucketing strategy for longer or shorter windows," and its Testing Decisions
repeat the same "25 fixed samples, deduped by calendar day" claim. Both are now false once
[issue #74](https://github.com/chethan123/portfolio/issues/74) lands, and a future reader of 0008 —
which stays canonical for the preset set, boundaries, and disabled-state rule — would otherwise be
misled about a part of the system it no longer accurately describes.

Update both passages to state that sampling now adapts to the span, cite spec 0009 and ADR-0003 for
the detail, and remove the specific "25"/"at most 8" figures from user story 23, replacing it with
the current, budget-relative behavior.

**Blocked by:** [Issue #74](https://github.com/chethan123/portfolio/issues/74) — this should
describe the shipped behavior, not the planned one, so it lands after or alongside that change
rather than before it.

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `docs/specs/0008-chart-ranges.md`'s Implementation Decisions no longer claims sampling is
      unchanged or fixed at 25; it points to 0009 for the current behavior.
- [ ] Its Testing Decisions bullet repeating the "25 fixed samples" claim is corrected the same way.
- [ ] User story 23 no longer names a specific sample count as the thing being preserved.
- [ ] No other part of 0008 — the preset set, boundary semantics, disabled-state rule, persistence
      cookie — is touched; this ticket corrects exactly the passages superseded by 0009.
