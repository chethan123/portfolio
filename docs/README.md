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
| [`../CLAUDE.md`](../CLAUDE.md) | Claude Code, at session start | the working brief: the read-first list, the commands and their traps, the rules a change is rejected against — it imports `AGENTS.md` and points at the document that owns each subject | project documentation of any kind |
| [`../CONTEXT.md`](../CONTEXT.md) | anyone naming a domain concept | the glossary: the word this project uses for each concept, and the ones it avoids | implementation detail, decisions, anything that is not a definition |
| [`adr/`](adr/) | someone about to undo a decision | one record per decision that is hard to reverse, surprising without its context, and the result of a real trade-off | decisions that are none of those three — they belong in the code or the design record |
| [`guide/`](guide/) | a family member using a running instance | how to do a thing, screen by screen and task by task, and files the guide hands out to do it (the example statement CSV) | rationale, operations, anything needing a terminal |
| [`operating.md`](operating.md) | whoever self-hosts the instance | how the deployment is put together and how to run it: installing, configuration, TLS, security posture, monitoring, backups, upgrades, growth | how to read a screen; what to do at 2am, which is the runbook's |
| [`runbook.md`](runbook.md) | the same person, mid-incident | symptoms, in the words someone would use, with the commands that confirm and fix each | explanation — every entry links to `operating.md` for the why |
| [`google-sign-in.md`](google-sign-in.md) | the self-hoster, once, before the first `docker compose up` | the walkthrough of standing the gate up: the Google Cloud project, the consent screen and publishing it, the OAuth client and its redirect URI, the gate's settings, the allowlist, and proving a sign-in and a refusal both work | how the gate is built and what it enforces, which is `ARCHITECTURE.md`'s and `operating.md`'s; why it is a forward-auth gate at all, which is the ADR's |
| [`importing-history.md`](importing-history.md) | the self-hoster, once, moving pre-app history into the instance | where each kind of outside history belongs, how to get it out of the old tracker, and the terminal work of loading and verifying it | how to use a screen, which is the guide's; running the instance day to day, which is `operating.md`'s |
| [`data-model.md`](data-model.md) | someone holding a database dump — extracting from it, or rebuilding the service around it | the schema explained: every table and column, the relationships and invariants, the derived valuation objects, the seed rows, and worked extraction queries | the design argument, which is `DESIGN.md`'s; how the code is arranged, which is `ARCHITECTURE.md`'s |
| [`developing.md`](developing.md) | a developer who has just cloned this | the mechanics of doing the work: a working checkout, the commands, the change loop, recipes, and the traps | the standards, which are `AGENTS.md`, and the structure, which is `ARCHITECTURE.md` |
| [`specs/`](specs/) | whoever builds the slice | approved work, before it is built | anything not agreed yet |
| [`design/`](design/) | whoever builds the screen | UI briefs a slice is drawn from | the decision to build it — that is a spec |
| [`research/`](research/) | whoever revisits a decision | investigation, including options that were rejected, and test reports written to be picked up as work | anything approved, which is a spec |
| `research/<report>/figures/` | that report's reader | the images one research or test report renders, beside the report | anything another document renders — those belong with that document |
| `research/<report>/harness/` | whoever reruns that report | the scripts one test report's findings were produced with, so a reader can reproduce them rather than trust them | anything the application runs — a harness is evidence, never a dependency |
| [`agents/`](agents/) | agents, via the skills in `.claude/skills/` | this repo's answers to what a skill needs to know: issue tracker, triage labels, domain docs | project documentation — these are configuration |
| [`screenshots/`](screenshots/) | the README | the images that file renders, and the editorial reasons behind them | the guide's images, which live beside the guide |
| [`guide/images/`](guide/images/) | the guide | the images the guide renders | the README's images |
| `specs/<slice>/screenshots/` | a pull request's reviewer | before/after captures proving one ticket's change, deleted once that pull request merges | anything a document renders — a lasting image is the README's or the guide's |

## Two things this table names, created lazily

`CONTEXT.md` at the repository root and `docs/adr/` both now exist, and both are in the table above.
[`agents/domain.md`](agents/domain.md) describes them and [`../AGENTS.md`](../AGENTS.md) points at
them. Neither is filled in preemptively: a term earns a glossary entry the first time it is
genuinely resolved, and a decision earns an ADR only when it is hard to reverse, surprising without
context, and the result of a real trade-off. The dividends work
([`specs/0006-dividends.md`](specs/0006-dividends.md)) opened both; the slices since have grown them
one resolved term and one hard decision at a time, which is the intended pace.

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
- **[`data-model.md`](data-model.md) retells the migrations' DDL, `DESIGN.md` §2–§8's rules, and
  `ARCHITECTURE.md` §5's schema walk** — entity diagram included — for a reader who may have none of
  them open: someone with only a dump. Named there, in place, with the migrations given as the ones
  to believe: their header comments carry the reasoning, and the document describes rather than
  replaces them.
- **[`google-sign-in.md`](google-sign-in.md) restates the shapes of the gate's settings**, which
  `.env.example` owns beside the blanks they fill — the cookie secret's length and the command that
  generates one, and the origin's form. Named there, in place, with `.env.example` given as the one
  to believe. The walkthrough itself is not duplicated: `operating.md` and `.env.example` both point
  at that file rather than carrying a second copy of the console steps.
- **[`importing-history.md`](importing-history.md) retells the two chart series** that `DESIGN.md`
  §7 defines and the guide's Overview page describes, for a third reader: someone deciding where
  outside history belongs before loading any of it. It carries the mapping and links to those two
  for every rule's reason.
- **[`runbook.md`](runbook.md) and [`operating.md`](operating.md) cover the same failures** at
  different moments: one indexed by symptom and read while something is broken, the other by topic
  and read while it is not. The seam that keeps them from drifting is that the runbook explains
  nothing — it confirms, acts, and links.
- **[`operating.md`](operating.md) overlaps `ARCHITECTURE.md` §7.4, §7.6 and §7.7** on
  observability, security and the installed shell. Those sections hold the mechanism, for a
  contributor; `operating.md` holds the decisions an operator has to make, and links rather than
  restating.
- **[`developing.md`](developing.md) sits between `AGENTS.md` and `ARCHITECTURE.md`** and must not
  become either. `AGENTS.md` says what good work looks like here; `ARCHITECTURE.md` says how the code
  is arranged and why. `developing.md` says how to get a checkout working and what to run — it links
  for every rule and every reason rather than carrying a second copy.
- **[`../README.md`](../README.md)'s "Working on it" is the short version of
  [`developing.md`](developing.md).** The README's reader may not have decided to contribute yet, so
  it keeps a handful of commands and defers the rest.
- **The price archive's storage figure is stated in five places**, because it is a number five
  different readers need at five different moments: [`adr/0006-intraday-quotes-are-an-observation-log.md`](adr/0006-intraday-quotes-are-an-observation-log.md)
  argues why the cost is worth paying, [`../DESIGN.md`](../DESIGN.md) §6 records it as part of the
  pricing design, the header of `migrations/0009_price_observation.sql` states it where the table
  is created, [`operating.md`](operating.md)'s "Growth and limits" carries the arithmetic and the
  query that measures the real instance, and Settings → Prices states it at the dial, where the
  household actually turns it. **The ADR is the one to believe**; the other four are derived from it
  and none of them may quietly disagree. A revised figure changes all five in one commit.

## Screenshots

Both image directories hold captures of the real application against the demo household in
[`../scripts/seed-demo.ts`](../scripts/seed-demo.ts) — never a mock, never hand-edited. They are
committed because a README has to render on GitHub for someone who has installed nothing, which
makes them the one thing here that can go stale in silence.

Retake all of them with [`../scripts/capture-screenshots.ts`](../scripts/capture-screenshots.ts).
**A change to a screen is not finished until they are retaken.** The editorial decisions — which
account each shot is of, why the warning strip is left in, why phone shots are not full-page —
live in [`screenshots/README.md`](screenshots/README.md) and
[`guide/images/README.md`](guide/images/README.md), because a script can hold the mechanics but not
the reasons.
