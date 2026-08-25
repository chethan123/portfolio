# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. See [DESIGN.md](DESIGN.md) for the full
design — domain model, ingest, pricing, screens, stack, and the accepted limitations.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI (`chethan123/portfolio`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` at the repo root and `docs/adr/`. Both exist and both stay small: a
term earns a glossary entry when it is actually resolved, a decision earns an ADR when it is hard to
reverse. A gap in either is not evidence that nothing was decided. See `docs/agents/domain.md`.

### Where documents go

`docs/README.md` is the layout authority for everything written down here. Read it before adding a
document, and fix it there first if it does not say where yours belongs.

## How I want you to work

**Replies.** I read these on a phone. Answer first, then bullets. Short lines, no preamble, no
closing summary, no wide tables. Point at `file:line` instead of pasting long code or diffs.
Anything long belongs in a file, not the reply.

**Questions.** When something critical is genuinely unclear, ask — a wrong assumption there costs
a rewrite. One question per turn, then wait. Routine judgement calls are yours: make them and
state the assumption in one line.

**Delegation.** Subagents are the default unit of work here, not the escalation. Anything that reads
more than it writes goes to one — a search across the codebase, a library's current docs, a review
pass, a spec or plan read end to end — and independent pieces go to several at once, dispatched
in a single turn. Keep for yourself the decisions, the edits, and the reply to me. Brief each
subagent as though it has read nothing: what it is looking at, what to hand back, and which file
or document is the authority for its answer.

**Plans and specs.** Neither reaches me first draft. Write it, then hand it to a subagent as
adversarial reviewer whose mandate is to **ground** it: every file, function, helper, column and
library behaviour the document names has to exist and do what the document says, verified against
this repository and the library's current docs rather than against the document's own argument. The
reviewer also hunts the two failure modes — a near-copy of a util, loader or query the repo
already has, and a shape more elaborate than the problem needs. Fold in what survives, send it
round again, and stop when a round comes back with nothing material. Then show me the result and
say which findings you rejected and why.

**Tasks.** A slice breaks into per-ticket specs under `docs/specs/<slice>/`, and
[`docs/specs/ingest/02-tolerant-csv-reader.md`](docs/specs/ingest/02-tolerant-csv-reader.md) is the
shape to copy. One ticket is one thing that can be built, tested and reviewed on its own. Write each
so an agent that has read nothing else can start from it: what to build and where, why it is worth
doing separately, the acceptance checklist, and a **Blocked by** line naming the tickets that
have to land first — "Nothing" where it is genuinely free to start, which is what says several
can run at once.

**Types.** `any` never ships. Where a value is genuinely unknown, `unknown` plus a narrowing — zod
is already a dependency. Derive types from the schema and `app/lib/database.generated.ts` rather
than hand-writing a second copy. `npm run typecheck` is the gate.

**Tests.** Test what would hurt to break: domain rules, money and quantity maths, ingest and
parsing edges, and a reproducing case for every bug fixed. Leave alone the tests that assert
framework behaviour, restate the implementation line by line, or mock so heavily they only
exercise the mock. Fewer, sharper tests.

**Docs.** Check a library's current docs before using it, rather than recalling — this stack moves
(React Router 7, React 19, Kysely, Zod 4, Vitest 4, Node 24). Say which version you checked when
it drives the decision.

**Pull requests.** One logical unit each: a change that typechecks, builds, and carries its own
tests standing alone. A ticket is usually one pull request; a slice never is. Where the work is
genuinely large, land it as a sequence of pull requests that are each green on their own rather
than one branch that only makes sense whole. The reason is review — a diff I can hold in my head
is one I can actually judge.
