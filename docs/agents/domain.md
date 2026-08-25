# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `CONTEXT.md` and one `docs/adr/` at the repo root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Note that `DESIGN.md` at the repo root is the authoritative design record for this project — domain model, ingest, pricing, screens, stack, and accepted limitations. Read it before proposing structural changes. It is not a substitute for `CONTEXT.md` (a glossary) or ADRs (individual decisions with context and consequences), and the three serve different purposes.

## File structure

Where every document in this repository goes — including `CONTEXT.md` and `docs/adr/` — is [`../README.md`](../README.md). It is the layout authority; this file covers only how to *consume* the domain docs while exploring.

Two things worth repeating here, because they change what you do rather than where you look: `CONTEXT.md` and `docs/adr/` both exist now and are deliberately small — each gets an entry only when a term or a decision is actually resolved, so a gap in either is not evidence that nothing was decided — and the application lives in `app/`, not `src/`.

If this repo ever grows into a genuine multi-package monorepo, the multi-context layout is a root `CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context, with context-scoped `app/<context>/docs/adr/` alongside the system-wide `docs/adr/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
