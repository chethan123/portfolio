# 00 — Require `POSTGRES_PASSWORD`

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.5)._

**What to build:** Stop `compose.yaml:59` falling back to `POSTGRES_PASSWORD:-portfolio`, and chase
every consequence of that one change.

**Why it is first, and why it is separate.** A minimal worker role means nothing while the superuser
password is guessable — a compromised worker would simply reconnect as `portfolio`/`portfolio`.
Ticket 03 attaches an egress-capable container to `db`, so the window between that and the cutover
is exactly when the default password matters most. And this ticket couples to nothing else in the
slice: it is a pre-existing weakness, it is the highest-blast-radius operator change here (existing
clusters need `ALTER ROLE portfolio PASSWORD …` or they lose authentication), and it is the one part
of this slice worth having if the rest is never built. Bundled into the cutover it would be one
deploy where two independent things can break, with a rollback that cannot separate them.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**The change and its three coupled edits**

- [ ] `compose.yaml:59` becomes `${POSTGRES_PASSWORD:?…}` with a message pointing at the runbook
- [ ] The app and dump `DATABASE_URL` defaults are re-derived from it (`:126`, `:204` — the coupling
      the comment at `:56-57` already warns about) to
      `postgres://portfolio:${POSTGRES_PASSWORD}@db:5432/portfolio`, or both services crash-loop on
      first start with a non-default password
- [ ] `.env.example:23` — whose explicit `DATABASE_URL=postgres://portfolio:portfolio@…` would
      override the re-derived default for anyone following the documented `cp .env.example .env`
      flow — and `:104`'s commented `#POSTGRES_PASSWORD=portfolio`
- [ ] `compose.yaml:20`'s "Every other setting has a working default" is no longer true

**The password alphabet, and why per character**

- [ ] Documented as URL-safe, with the reason for each exclusion rather than the label: `/`, `?` and
      `#` truncate or reparse the authority; `@` re-splits the userinfo; and `%` is
      percent-**decoded** by `pg-connection-string`, so `abc%41def` in `.env` connects as `abcAdef`
      — a silent mismatch that reads to an operator as a wrong password

**Smoke**

- [ ] `smoke-test.sh:109-116` currently runs `docker compose --env-file /dev/null config` with only
      the four gate variables unset and asserts the refusal names one of them. `db`
      (`compose.yaml:45`) precedes `gate` (`:233`), so the newly required variable is what Compose
      reports first and the assertion fails on its own success. Export `POSTGRES_PASSWORD` before
      that check, following the `DUMP_UID`/`DUMP_GID` precedent at `smoke-test.sh:39-40`, so it
      still isolates the gate variables.
- [ ] **A separate assertion** that unsetting `POSTGRES_PASSWORD` alone is refused by name —
      otherwise the newly required variable is the one thing smoke does not cover
- [ ] The rest of the run exports a value, so `up -d --build` (`:150`) still works

**Docs**

- [ ] `docs/operating.md`: the upgrade step existing clusters need — the initdb-time password is
      baked into the cluster, so `ALTER ROLE portfolio PASSWORD …` is required and editing `.env`
      alone breaks authentication
- [ ] `DESIGN.md:956-957` says the gate's variables "are the only settings anywhere with no default"
      — false after this ticket. **`ARCHITECTURE.md:249-256` carries the identical sentence** plus
      "`POSTGRES_PASSWORD` … must be kept in sync with the credentials inside `DATABASE_URL`". Fix
      both copies or the contradiction just moves.
- [ ] `docs/operating.md:174-182` — "every setting has a working default except `DATABASE_URL`… One
      more is worth deciding before the first `up`: `POSTGRES_PASSWORD`". "Worth deciding" becomes
      "required".
- [ ] `docs/operating.md:283-290` — "Neither variable is validated at startup… a typo surfaces as a
      failed pull, not as the message naming the variable." After `:?` an unset value *does* produce
      a message naming the variable.
- [ ] `docs/operating.md:308-314` — "`POSTGRES_PASSWORD` … configures `compose.yaml` rather than the
      app, **which is why it is not in the table above**". That directly contradicts adding the row
      to that table, whose header at `:246` says "All of them are validated once at startup" — which
      this variable never will be. Decide where it goes and make the two passages agree.
- [ ] `docs/runbook.md:525-547` ("I changed the database password and nothing connects") tells the
      operator at `:540-542` to set `POSTGRES_PASSWORD` **and** an explicit `DATABASE_URL` in `.env`
      — the very override trap this ticket removes from `.env.example`. Rewrite the recipe.
- [ ] The env tables in `DESIGN.md:944-951` and `docs/operating.md:250-257` gain the row

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
