# 06 — The standing rule, the guide, and the screenshots

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** The documentation that makes the filter a rule rather than four screens that
happen to agree, plus the household-facing guide and the retaken screenshots.

This is last because it describes what the previous five tickets did, and it is separate because
`docs/README.md` treats a screenshot retake as part of finishing a screen — bundling it into ticket
05 would mean one pull request whose diff is half prose and half PNG. The rule itself is already
enforced by the readers' required argument; what is written here is the reason, for whoever wonders
why their new screen will not compile.

**Blocked by:** 04 and 05 — the screens have to be final before they are photographed or described.

**Status:** ready-for-agent

**ARCHITECTURE.md**

- [ ] §4.2's single-site invariant list gains the owner filter: household-scoped readers require it,
      account-scoped readers do not take it, and a screen that reads holdings has therefore already
      decided
- [ ] §5.4 or §6.3 notes where the narrowing happens — inside the lateral for the series readers, on
      `account.owner_id` for the account totals — since that is the part a future change breaks
      silently
- [ ] Appendix A gains `app/lib/owner-filter.ts`

**DESIGN.md**

- [ ] §8.1 records that every money screen reads as one or more owners, and which screens are
      exempt and why (an account is already narrower; the upload flow and Settings are about records)
- [ ] §8.3 notes that the filter half of the deferred view builder now exists for one dimension, so
      the deferral is smaller than it was rather than untouched
- [ ] §7's rule 3 gains a sentence saying a filter, not only a grouping, now puts a screen into that
      case
- [ ] §14 is checked for a limitation this slice removes or narrows

**The guide** (`docs/guide/`)

- [ ] The household is told what the control does, in the guide's own register: how to narrow, how to
      clear, that it follows you between screens, and that closing the browser forgets it
- [ ] It says plainly that this is about noise, not privacy — everyone sees everything, and the
      filter is a way of reading
- [ ] The pre-app history's absence under a filter is explained where the Overview chart is described,
      so a shorter line is never mistaken for lost data
- [ ] `docs/guide/holdings.md` is corrected where it describes the Owner select that ticket 04
      removed

**README.md**

- [ ] The screen walkthrough mentions the filter where it explains what each screen is for
- [ ] Any statement that the Holdings table filters by owner is corrected to the household filter

**Screenshots**

- [ ] `scripts/seed-demo.ts` is checked for at least two account-owning people, since the control is
      not drawn otherwise — if it has fewer, the demo household gains one and the seed's own figures
      are re-checked
- [ ] All shots retaken with `scripts/capture-screenshots.ts` against the demo household, never
      hand-edited, per `docs/README.md`
- [ ] At least one shot shows a narrowed screen, since a control nobody can see in the README is a
      feature nobody knows exists
- [ ] `docs/screenshots/README.md` and `docs/guide/images/README.md` record the editorial reason for
      any new or changed shot

**Checks**

- [ ] `npm run typecheck`, `npm test` and `npm run build` all pass
- [ ] The glossary's three terms are used consistently in every document this ticket touches — owner
      for the role, person for the record, owner filter for the feature
