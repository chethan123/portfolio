# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a model-facing `description` with the trigger branches that let Codex discover it autonomously. It remains available to the user as `$skill-name`, and other skills can invoke it explicitly. The description is the skill's top-level context pointer, so the pointer-writing rules in `SKILL.md` apply in full. No invocation policy override is needed.
- A **user-invoked** skill remains available as `$skill-name` but must not fire implicitly. Keep its human-facing `description`, and add `policy.allow_implicit_invocation: false` to `agents/openai.yaml` beside the skill. Other skills can still invoke it explicitly.

Pick model invocation only when Codex must reach the skill on its own. If it only ever fires by hand or from an explicit workflow, make it user-invoked.

Shared reference needed by several skills can live in one skill when those workflows invoke it explicitly, or in a plain companion file when it has no workflow of its own.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can invoke them explicitly with `$skill-name`, while their policy prevents unrelated implicit invocation.
