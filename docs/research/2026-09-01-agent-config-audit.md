# Agent configuration audit

**Date:** 2026-09-01
**Question:** Is the agent-facing configuration in this repo (skills, instruction files, plugins)
bloated?
**Answer:** Yes by surface area, no by context cost. The per-session token budget is disciplined and
should be left alone. The weight is in 410 KB of vendored generic skills, carried twice, unadapted,
with several entries already dead or unusable.

---

## 1. What is actually here

There are no plugins, no MCP config, no hooks, and no `settings.json`. The whole agent surface is
instruction files plus vendored skills.

| Location | Files | Bytes | Read by |
|---|---|---|---|
| `.claude/skills/` | 75 | 204,912 | Claude Code |
| `.agents/skills/` | 75 | 203,533 | Codex |
| `CLAUDE.md` | 1 | 8,911 | Claude Code, every session |
| `AGENTS.md` | 1 | 4,509 | both, every session (`@`-imported by `CLAUDE.md`) |
| `docs/agents/` | 3 | 7,209 | skills, on demand |
| **Total** | **155** | **429,074** | |

For scale: `app/ + server/ + tests/ + migrations/` is 1,745,569 bytes. **Agent configuration is
~25% of the size of the codebase it describes**, in a repo with one human contributor
(`git shortlog`: 181 Claude, 79 chethan123).

All 25 skills are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at commit
`0ab1b63`, per `.claude/skills/NOTICE.md:1`. None were written for this project.

## 2. The context cost is fine — do not "optimise" it

This is the finding that should stop a naive cleanup.

- `CLAUDE.md` ≈ 1,630 tokens, `AGENTS.md` ≈ 970 tokens.
- 14 of 25 skills set `disable-model-invocation: true`, so they are slash-command only and
  contribute **zero** always-on context. Verified: this session's skill list surfaced exactly the
  11 model-invocable ones.
- The 11 remaining descriptions total ~2,562 bytes ≈ 640 tokens.

**Always-on total: ~3,240 tokens.** That is a well-run budget. The `disable-model-invocation`
discipline is doing real work and is the reason 205 KB of skills costs almost nothing per session.

Everything below is about repository surface area and maintenance burden, not tokens.

## 3. Findings

### 3.1 The two skill trees are the same content twice, with no sync mechanism — HIGH

`.claude/skills/` and `.agents/skills/` hold the same 25 skills. 50 of 75 files are byte-identical;
the 25 that differ do so only in invocation syntax (`/skill` and "Call the Skill tool" for Claude,
`$skill` for Codex).

The duplication is **legitimate**: `.agents/skills/` is genuinely Codex's repo-skill path, and `$`
is genuinely its mention syntax ([OpenAI Codex skills docs](https://developers.openai.com/codex/skills)).
Commit `d7ca5d6` added it deliberately. Nothing here is a mistake of principle.

The problem is that it was a one-time hand translation with **no script, no test, and no CI check**.
Drift has already started:

- `.agents/skills/implement/SKILL.md:8` and `:12` still say `/tdd` and `/code-review` — Claude
  syntax left in the Codex tree. The translation missed this file's body.
- `.claude/skills/*/agents/openai.yaml` — 25 files, 3,151 bytes — are inert. Claude Code never
  reads them; they are Codex metadata sitting in the Claude tree.

Invocation-policy parity does currently hold (every `disable-model-invocation: true` has a matching
`allow_implicit_invocation: false`), which is worth preserving — but nothing enforces it.

**This is the one finding with a real failure mode:** the next upstream bump has to be applied twice
and re-translated by hand, and a divergence will not be caught.

### 3.2 The `gh` CLI dependency is unusable in web and remote sessions — HIGH

`AGENTS.md:10` names the `gh` CLI as the issue tracker interface, and
`docs/agents/issue-tracker.md` specifies every operation as a `gh` command (28 `gh issue`, 17
`gh pr`, 6 `gh api`).

`gh` is **not installed** in Claude Code on the web, which is where a large share of this repo's
agent work happens. `which gh` returns nothing; the harness routes GitHub through MCP tools instead.

Every skill that touches the tracker is therefore inoperative in these sessions: `triage`,
`to-spec`, `to-tickets`, `wayfinder`, and the vendored `code-review`. That is five skills and the
single largest one (`triage`, 19,301 B).

This is not bloat — it is a portability gap. `docs/agents/issue-tracker.md` is the correct and only
place to fix it, since it exists precisely to hold this repo's tracker answers.

### 3.3 Zero adaptation to this repository — MEDIUM

24 of 25 skills contain no reference to this project's domain, stack, or invariants (searched for
`portfolio`, `holding`, `net worth`, `position_set`, `numeric`, `kysely`, `react-router`). Only
`setup-matt-pocock-skills` mentions anything repo-specific, and only because it writes the config
files.

The consequence is a split brain. The rules that actually govern a change here — arithmetic goes
down never up, `.server.ts` is a bundle boundary, money crosses the driver as strings,
`erasableSyntaxOnly` — live only in `CLAUDE.md:104-135`. The vendored `tdd` and `code-review` skills
know none of them. An agent running `/tdd` gets generic red-green guidance, not this repo's money
assertions or `withDatabase` convention, both of which are documented in `CLAUDE.md:120-135` and
`docs/developing.md`.

The skills are not wrong. They are just not about this codebase, while presenting as this
codebase's process.

### 3.4 Dead and near-dead entries — MEDIUM

| Item | Bytes | Why it is dead |
|---|---|---|
| `setup-matt-pocock-skills/` | 19,421 | Run-once precondition, already satisfied — `docs/agents/` and `docs/adr/` both exist. The largest skill in the repo is a completed migration script. |
| ├ `issue-tracker-gitlab.md` | 3,809 | Repo uses GitHub. |
| ├ `issue-tracker-local.md` | 1,810 | Repo uses GitHub. |
| `docs/agents/triage-labels.md` | 970 | An identity mapping. Every row maps a label to itself (`needs-triage` → `needs-triage`, five times). It exists only because the upstream skill demands the file. |
| `teach/` | 17,978 | A personal multi-session learning workspace. Unrelated to shipping this app. |
| `triage/` | 19,301 | Built around external PRs, `authorAssociation` filtering, and first-time contributors — and `docs/agents/issue-tracker.md:19` already sets **"PRs as a request surface: no"**, switching off the part it is largest for. One human contributor. |

Doubled across both trees, the run-once and switched-off material alone is roughly 80 KB.

### 3.5 Redundant entry points over one primitive — LOW

Three skills wrap the same `grilling` primitive, two of them as one-line files:

- `grill-me/SKILL.md` — 294 B, body is a single line: "Call the Skill tool with `grilling`."
- `grill-with-docs/SKILL.md` — 392 B, body is a single line calling `grilling` + `domain-modeling`.
- `grilling/SKILL.md` — 2,100 B, the actual primitive.

Plus `ask-matt/` (15,803 B), a router whose job is to explain the resulting map. A 15 KB navigation
document is itself evidence the skill set is larger than the work needs. `wait-what` (552 B) and
`implement` (572 B) are similarly thin.

### 3.6 An unresolved name collision — LOW

Two different `code-review` skills exist: this session's built-in (diff review) and the vendored
Standards+Spec one, which shadows it. `.claude/skills/NOTICE.md:37-42` documents the collision
honestly and says "rename or remove one if the collision is unwanted" — but it was never resolved.
The winner is the one that needs `gh` (§3.2), so in web sessions `/code-review` resolves to the
broken variant.

### 3.7 `CLAUDE.md` / `AGENTS.md` overlap is minor and mostly deliberate — NOT A PROBLEM

`CLAUDE.md:137-145` restates four `AGENTS.md` items (PR sizing, current docs, test philosophy, reply
style). It cites `AGENTS.md` for the reply rule, and `CLAUDE.md:6-8` states the split explicitly:
`AGENTS.md` is imported, everything else is a pointer. The division of labour is sound and the
duplication is about five lines. Leave it.

All links checked in both files resolve, including
`docs/specs/ingest/02-tolerant-csv-reader.md` (`AGENTS.md:54`).

## 4. Recommendations, in order

1. **Fix `docs/agents/issue-tracker.md` to name both interfaces** — `gh` where present, GitHub MCP
   tools otherwise. Single file, unblocks five skills in web sessions. Highest value per byte
   changed. (§3.2)
2. **Delete `setup-matt-pocock-skills/`, `teach/`, and the two unused tracker variants** from both
   trees. ~80 KB, zero behaviour change — the setup skill's output is already committed. (§3.4)
3. **Replace the two one-line grill wrappers with the primitive**, or keep one. (§3.5)
4. **Resolve the `code-review` collision** by renaming the vendored one, per its own NOTICE. (§3.6)
5. **Make the Codex tree derived, not hand-maintained** — a script that generates `.agents/skills/`
   from `.claude/skills/` with the syntax substitution, plus a CI check that the tree is in sync,
   the way `db:types -- --verify` already guards `database.generated.ts`. Fix the `implement`
   drift while doing it, and drop the inert `openai.yaml` copies from `.claude/`. (§3.1)
6. **Decide whether `triage` and `wayfinder` earn their place** for a one-maintainer repo before
   investing in keeping them synced. (§3.4)
7. **Leave the context budget alone.** Do not trim `CLAUDE.md`, and do not remove
   `disable-model-invocation` flags. (§2)

Items 1–4 are mechanical and independent. Item 5 is the one that stops the problem recurring.

## 5. What was checked

- Both skill trees enumerated, diffed file by file, and frontmatter parsed for every skill.
- `disable-model-invocation` count cross-checked against the skill list this session actually
  received (11 = 25 − 14 ✓).
- `gh` and `hub` availability tested directly.
- Every `docs/agents/` file read in full; every path referenced from `AGENTS.md` and `CLAUDE.md`
  resolved.
- Codex's `.agents/skills` path and `$` mention syntax verified against
  [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills), not recalled.
- Commit `d7ca5d6` read for the intent behind the second tree.
