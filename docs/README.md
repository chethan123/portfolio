# Where documents go

This file is the layout authority. Use it to choose where a document belongs; add a missing category
here before creating one.

## Writing rules

- State rules rather than counts that drift as code changes.
- Describe refusals and behavior; avoid copying UI messages. Quote exact text only when it matters.
- Keep each rule in its owning document. Where repetition helps a different audience, link to that source.
- Current guides describe the code. Dated research and original specs record their own time and scope.

## The layout

| Path | Reader | What belongs | What does not |
|---|---|---|---|
| [`../README.md`](../README.md) | someone who has installed nothing | what this is, what the screens look like, why each behaves as it does, how to run an instance | step-by-step instructions for using a screen, which are the guide's |
| [`../DESIGN.md`](../DESIGN.md) | anyone changing the system | the authoritative design record: domain model, ingest, pricing, screens, stack, accepted limitations | anything already settled and shipped that a reader would rather see in code |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | a contributor finding their way around | how the code is arranged and why the seams sit where they do | user-facing behaviour |
| [`../AGENTS.md`](../AGENTS.md) | agents working in this repo | how work here is done and judged | project documentation of any kind |
| [`../CLAUDE.md`](../CLAUDE.md) | Claude Code, at session start | the working brief: the read-first list, the commands and their traps, the rules a change is rejected against. It imports `AGENTS.md` and points at the document that owns each subject | project documentation of any kind |
| [`../CONTEXT.md`](../CONTEXT.md) | anyone naming a domain concept | the glossary: the word this project uses for each concept, and the ones it avoids | implementation detail, decisions, anything that is not a definition |
| [`adr/`](adr/) | someone about to undo a decision | one record per decision that is hard to reverse, surprising without its context, and the result of a real trade-off | decisions that are none of those three, which belong in the code or the design record |
| [`guide/`](guide/) | a family member using a running instance | how to do a thing, screen by screen and task by task, and files the guide hands out to do it (the example statement CSV) | rationale, operations, anything needing a terminal |
| [`security.md`](security.md) | someone deciding whether to trust this instance with their money, before and after installing it | the threat model made visual: what the segmentation, the egress allowlist and the lock each defend, what the supply chain does and does not do, the standing list of what is not defended, and the short list of what the stack cannot do for the operator at all | how to turn any of the knobs it names, which is `operating.md`'s; the control table and the seams, which are `ARCHITECTURE.md`'s |
| [`operating.md`](operating.md) | whoever self-hosts the instance | how the deployment is put together and how to run it: installing, configuration, TLS, security posture, monitoring, backups, upgrades, growth | how to read a screen; what to do at 2am, which is the runbook's; the restore procedure, which is `restoring-a-dump.md`'s |
| [`runbook.md`](runbook.md) | the same person, mid-incident | symptoms, in the words someone would use, with the commands that confirm and fix each | explanation, because every entry links to the document that owns the why — `operating.md`, or `restoring-a-dump.md` for a restore |
| [`restoring-a-dump.md`](restoring-a-dump.md) | the same person, holding an archive the `dump` service wrote | the one restore procedure: choosing an archive, proving it before trusting it, restoring in place, rebuilding a machine, the drill, and what a restore leaves the dumper to sort out | why the stack dumps at all, which is the ADR's; the knobs and the schedule, which are `.env.example`'s; what a collector carries off the host, which is `operating.md`'s; what is inside a dump, which is `data-model.md`'s |
| [`google-sign-in.md`](google-sign-in.md) | the self-hoster, once, before the first `docker compose up` | the walkthrough of standing the gate up: the Google Cloud project, the consent screen and publishing it, the OAuth client and its redirect URI, the gate's settings, the allowlist, and proving a sign-in and a refusal both work | how the gate is built and what it enforces, which is `ARCHITECTURE.md`'s and `operating.md`'s; why it is a forward-auth gate at all, which is the ADR's |
| [`importing-history.md`](importing-history.md) | the self-hoster, once, moving pre-app history into the instance | where each kind of outside history belongs, how to get it out of the old tracker, and the terminal work of loading and verifying it | how to use a screen, which is the guide's; running the instance day to day, which is `operating.md`'s |
| [`data-model.md`](data-model.md) | someone holding a database dump, extracting from it or rebuilding the service around it | the schema explained: every table and column, the relationships and invariants, the derived valuation objects, the seed rows, and worked extraction queries | the design argument, which is `DESIGN.md`'s; how the code is arranged, which is `ARCHITECTURE.md`'s |
| [`developing.md`](developing.md) | a developer who has just cloned this | the mechanics of doing the work: a working checkout, the commands, the change loop, recipes, and the traps | the standards, which are `AGENTS.md`, and the structure, which is `ARCHITECTURE.md` |
| [`specs/`](specs/) | whoever builds the slice | approved work, before it is built | anything not agreed yet |
| [`design/`](design/) | whoever builds the screen | UI briefs a slice is drawn from | the decision to build it, which is a spec |
| [`research/`](research/) | whoever revisits a decision | investigation, including options that were rejected, and test reports written to be picked up as work | anything approved, which is a spec |
| `research/<report>/figures/` | that report's reader | the images one research or test report renders, beside the report | anything another document renders, which belongs with that document |
| `research/<report>/harness/` | whoever reruns that report | the scripts one test report's findings were produced with, so a reader can reproduce them rather than trust them | anything the application runs, because a harness is evidence, never a dependency |
| [`agents/`](agents/) | agents, via the skills in `.claude/skills/` | this repo's answers to what a skill needs to know: issue tracker, triage labels, domain docs | project documentation, because these are configuration |
| [`screenshots/`](screenshots/) | the README | the images that file renders, and the editorial reasons behind them | the guide's images, which live beside the guide |
| [`guide/images/`](guide/images/) | the guide | the images the guide renders | the README's images |
| `specs/<slice>/screenshots/` | a pull request's reviewer | before/after captures proving one ticket's change, deleted once that pull request merges | anything a document renders, because a lasting image is the README's or the guide's |

## Screenshots

README images live in `screenshots/`; guide images live in `guide/images/`. Both show the real app
with invented data from [seed-demo.ts](../scripts/seed-demo.ts).

Retake affected captures after a screen changes. [capture-screenshots.ts](../scripts/capture-screenshots.ts)
retakes both sets; [Developing](developing.md#retake-screenshots-after-changing-a-screen) has the recipe.
The image directories' README files explain the capture choices.
