# Where documents go

This file is the layout authority for everything written down in this repository. If you are about
to add a document and cannot tell from the table below where it belongs, that is a gap in this file
— fix it here first, then write the document.

## Three rules that apply everywhere

**State rules, not counts.** "Every route has a test" survives a commit; "35 test files, 590 cases"
is wrong the moment someone adds one, and nothing fails when it goes wrong. The same goes for
"three panels", "seven columns" and any other number a reader could recount. Where a count really is
the point, say where it is counted from.

**Never transcribe a string the code owns.** Refusal messages, button labels and empty-state copy
live in `app/`, are written to be read by the household already, and change without anyone thinking
to grep the docs. Describe what a screen refuses and why; quote it only where the exact words are
the subject, and expect to re-check that quote.

A **contract** is the exception, and the difference is whether something else already fails when it
changes. The `/healthz` response body is pinned by a test and read by machines, so quoting it is how
an operator knows what to match on. A log line is not a contract: describe the signal and give a
stem worth grepping for, rather than a sentence that will drift. When in doubt, ask what breaks if
the string changes — if the answer is "only this document", describe it instead.

**Name a deliberate duplication where you make it.** Some things are worth saying twice to two
different readers. [`operating.md`](operating.md) does this for `.env.example` and says so in place.
An unmarked second copy is a future contradiction; a marked one is a decision.

## The layout

| Path | Reader | What belongs | What does not |
|---|---|---|---|
| [`../README.md`](../README.md) | someone who has installed nothing | what this is, what the screens look like, why each behaves as it does, how to run an instance | step-by-step instructions for using a screen — those are the guide's |
| [`../DESIGN.md`](../DESIGN.md) | anyone changing the system | the authoritative design record: domain model, ingest, pricing, screens, stack, accepted limitations | anything already settled and shipped that a reader would rather see in code |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | a contributor finding their way around | how the code is arranged and why the seams sit where they do | user-facing behaviour |
| [`../AGENTS.md`](../AGENTS.md) | agents working in this repo | how work here is done and judged | project documentation of any kind |
| [`guide/`](guide/) | a family member using a running instance | how to do a thing, screen by screen and task by task | rationale, operations, anything needing a terminal |
| [`operating.md`](operating.md) | whoever self-hosts the instance | how the deployment is put together and how to run it: installing, configuration, TLS, security posture, monitoring, backups, upgrades, growth | how to read a screen; what to do at 2am, which is the runbook's |
| [`runbook.md`](runbook.md) | the same person, mid-incident | symptoms, in the words someone would use, with the commands that confirm and fix each | explanation — every entry links to `operating.md` for the why |
| [`specs/`](specs/) | whoever builds the slice | approved work, before it is built | anything not agreed yet |
| [`design/`](design/) | whoever builds the screen | UI briefs a slice is drawn from | the decision to build it — that is a spec |
| [`research/`](research/) | whoever revisits a decision | investigation, including options that were rejected | anything approved, which is a spec |
| [`agents/`](agents/) | agents, via the skills in `.claude/skills/` | this repo's answers to what a skill needs to know: issue tracker, triage labels, domain docs | project documentation — these are configuration |
| [`screenshots/`](screenshots/) | the README | the images that file renders, and the editorial reasons behind them | the guide's images, which live beside the guide |
| [`guide/images/`](guide/images/) | the guide | the images the guide renders | the README's images |

## Two things this table names that do not exist yet

`CONTEXT.md` at the repository root, and `docs/adr/`. [`agents/domain.md`](agents/domain.md)
describes both, and [`../AGENTS.md`](../AGENTS.md) points at them. They are created lazily — the
first time a term is genuinely resolved, or a decision genuinely needs recording — by the
`/domain-modeling` skill. Their absence is not a gap to fill preemptively. If you create either,
add its row here.

## Deliberate duplications, and why

- **[`../README.md`](../README.md) and [`guide/`](guide/) both walk every screen.** The README says
  what a screen is and why it behaves as it does, to someone deciding whether to install this at
  all. The guide says how to get something done, to someone who already has it open. Neither should
  contain the other's sentences: when the guide needs a *why*, it links.
- **The README's "Reading what is held" and "Recording people and accounts" sections overlap the
  guide on user-visible rules** — nothing is deleted, closing is not deleting, an unpriced holding
  is not a zero. The README states them at the altitude of a module seam for a contributor; the
  guide states them as consequences for a household.
- **[`operating.md`](operating.md) restates parts of `.env.example`.** Named there, in place.
- **[`runbook.md`](runbook.md) and [`operating.md`](operating.md) cover the same failures** at
  different moments: one indexed by symptom and read while something is broken, the other by topic
  and read while it is not. The seam that keeps them from drifting is that the runbook explains
  nothing — it confirms, acts, and links.
- **[`operating.md`](operating.md) overlaps `ARCHITECTURE.md` §7.4 and §7.6** on observability and
  security. Those sections hold the mechanism, for a contributor; `operating.md` holds the decisions
  an operator has to make, and links rather than restating.

## Screenshots

Both image directories hold captures of the real application against the demo household in
[`../scripts/seed-demo.ts`](../scripts/seed-demo.ts) — never a mock, never hand-edited. They are
committed because a README has to render on GitHub for someone who has installed nothing, which
makes them the one thing here that can go stale in silence.

Retake all of them with [`../scripts/capture-screenshots.ts`](../scripts/capture-screenshots.ts).
**A change to a screen is not finished until they are retaken.** The editorial decisions — which
account each shot is of, why the no-password banner is left in, why phone shots are not full-page —
live in [`screenshots/README.md`](screenshots/README.md) and
[`guide/images/README.md`](guide/images/README.md), because a script can hold the mechanics but not
the reasons.
