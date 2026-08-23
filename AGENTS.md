# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. See [DESIGN.md](DESIGN.md) for the full
design — domain model, ingest, pricing, screens, stack, and the accepted limitations.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI (`chethan123/portfolio`). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## How I want you to work

**Replies.** I read these on a phone. Answer first, then bullets. Short lines, no preamble, no
closing summary, no wide tables. Point at `file:line` instead of pasting long code or diffs.
Anything long belongs in a file, not the reply.

**Questions.** When something critical is genuinely unclear, ask — a wrong assumption there costs
a rewrite. One question per turn, then wait. Routine judgement calls are yours: make them and
state the assumption in one line.

**Plans.** Write the detailed plan, then hand it to a subagent as adversarial reviewer before
showing it to me. The reviewer works from the codebase, not from the plan's own claims: verify
each file, function and helper it names exists and does what the plan says; look for the simpler,
more maintainable shape; and flag anything that reimplements what the repo already has — a
near-copy of an existing util, loader, or query is the failure mode to hunt. Fold the findings in,
and tell me which you rejected and why.

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
