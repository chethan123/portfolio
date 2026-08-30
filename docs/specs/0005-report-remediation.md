# 0005 — Remediating the 2026-08-24 exploratory test report

Eight of the report's sixty-seven findings, in the order they should be built. Five High, two
Medium, one Low. `SET-1`, the report's only Critical, was already fixed in `f9198d4`.

Every load-bearing claim below was checked against a running instance rather than read off the
report, and the plan went through two adversarial review rounds before it was written down. Two of
those rounds' findings are recorded in place, because they are the reason to read the rest of this
sceptically: the first draft would have shipped an open redirect and a crash fix that did not stop
the crash.

## What the review changed

**The redirect fix introduced an open redirect.** Re-resolving the target through `new URL()` runs
RFC 3986 dot-segment removal, which *synthesises* the leading `//` the input guard just rejected:
`/..//evil.example.com` came out as `//evil.example.com`, which a browser reads as an authority
rather than a path. Today's shipped code is safe on that input; the proposed fix was strictly worse,
on five of five vectors. The cure is to validate the output, not only the input.

**The crash fix did not close the crash.** `pool.on("error")` covers only *idle* clients —
`pg-pool` removes its idle listener on checkout (`node_modules/pg-pool/index.js:344`). The price
poller holds a client across a network round trip (`price-poller.server.ts:101` to `:113`), and a
Postgres restart landing in that window still killed the process after the fix. Measured against a
live database, terminating a real backend:

| Client state | Guard | Outcome |
|---|---|---|
| Idle in pool | none | process died — reproduces `LEAD-8` |
| Idle in pool | `pool.on("error")` | survived |
| **Checked out** | `pool.on("error")` | **process died** |
| Checked out | `+ acquire` listener | survived |

Round two cleared both corrections. The corrected redirect function was exhausted over 464,000
inputs with zero off-origin results and zero throws. The feared side effect of the pool correction —
that swallowing a client error would leave a query hanging — is disproven: `pg` calls
`_errorAllQueries` before `emit('error')`, so the rejection is already queued. A Kysely
`pg_sleep(30)` killed mid-query rejected in 503 ms.

## The build order

The sequence is a dependency chain, not a preference: each step removes a tax the next would pay.

| # | Pull request | Closes |
|---|---|---|
| 1 | Refuse a date before the first day this application can price | `SET-2` High, `SET-3` Medium |
| 2 | Keep serving when Postgres closes a connection | `LEAD-8` High, `LEAD-6` Low |
| 3 | Send a redirect nowhere but this instance | `SEC-1` High, `SEC-3` Medium |
| 4 | Refuse a quantity recorded under no instrument | `ING-4` High |
| 5 | Say when a statement is filed behind | `ING-1` High |

---

## 1 — Refuse a date before the first day this application can price

`recordedDate` (`input.server.ts:280-282`) has a future ceiling and no floor. A one-character typo,
`1026` for `2026`, writes a position set a thousand years back and permanently flattens the "All"
net-worth chart with no way back. `asOf=0000-01-01` passes the validator and 500s in the driver.

The floor is `1970-01-01`, exported as `earliestRecordableDate()` mirroring the existing
`latestRecordableDate()`, and wired as `min=` on both date controls. That date rather than an
arbitrary 1900 because `migrations/0001_initial_schema.sql:280` seeds `USD` a close of `1.00` dated
`1970-01-01` and `holding_valued_at` carries prices forward only — so a statement dated before it
produces a chart point on which even cash is unpriced. A sweep of `tests/`, `app/`, `migrations/`
and `scripts/` for any date before 1970 returns nothing, so the floor breaks no fixture.

The test belongs in `tests/balance-input.test.ts`, which already has a `describe("recordedDate")`.

`statement.ts:604` runs a file's own as-of date through the same validator, so a statement dating
itself 1969 now refuses at the parser. That is intended, but the row rules enumerated at
`statement.ts:292-307` gain one and must be updated with it.

## 2 — Keep serving when Postgres closes a connection

`server/db.ts:61-70` builds `new pg.Pool({...})` with no error listener anywhere in the tree.
Reproduced by warming the pool and terminating its backends: the process exits with
`throw er; // Unhandled 'error' event`.

Both handlers go in `createPool`, so all eight call sites inherit them by construction — the
invariant `ARCHITECTURE.md` §4.2 already claims for this function.

Both are load-bearing, and the comment saying so is part of the fix. Round two ran the acquire
listener alone against an idle drop: it logged, and the process still died, because `pg-pool`'s own
idle listener re-emits on the pool. Since the client handler logs first, a later reader will
conclude the pool handler is dead code and delete it, reintroducing the crash.

Held from the first draft: no `uncaughtException` net, because it would mask three deliberate
fail-closed exits and there is nowhere to put it — the app is served by `react-router-serve` over
the framework build, which is why the poller starts from a route loader. `max`,
`idleTimeoutMillis` and `statement_timeout` stay out: none influences this crash,
`docs/runbook.md:252-280` teaches an operator that there is no statement timeout, and
`idleTimeoutMillis` defines the window the regression test lives in. Log and swallow rather than
tracking a degraded state, because `/healthz` answers live on every call and its body is a contract
pinned with `toEqual`.

The tests go in a new `tests/pool-resilience.test.ts`, named after the rule rather than the module
because `server/db.ts`'s other guarantee already has a file in `tests/numeric.test.ts`. Capture the
backend pid and terminate that one; never match on `datname`, because the suite shares one database
and that would kill the shared harness pool. Cover both an idle client and one held checked out
across an await. Wait on the production `console.error` spy and assert the message stem — not on a
test-added listener, which would itself prevent the crash and pass against unfixed code. Both pools
need `afterAll` teardown or the run hangs.

Cut from the first draft: a `pool.listenerCount("error") >= 1` assertion. It restates the
implementation, and its justification — that it covers call sites no behavioural test reaches — is
false, since every call site goes through `createPool` and it therefore checks the same ground. If
the real goal is "nobody builds a second pool", that is a source scan and belongs in
`tests/invariants/`.

`LEAD-6` lands first in the same PR. `ARCHITECTURE.md` §4.2 navigates by line number and three of
its seven citations have already drifted; this change contorts itself to keep `server/db.ts:62`
true, and PRs 3 and 5 hit the same tax. Cite by symbol once and the constraint disappears.

Verify against a production build rather than the dev server — the finding reproduces on both, and
the build is what an operator runs. Curl `/healthz` immediately before terminating, or there may be
nothing idle to kill and the run passes for the wrong reason. Then restart a private cluster with
`pg_ctl -m fast` to prove recovery rather than survival, and finally comment the handlers out and
confirm it dies again.

The commit body should name the interaction with `LEAD-5`: today the crash accidentally re-runs
migrations, because `restart: unless-stopped` fires on exit and the entrypoint re-runs `migrate`.
After the fix the app survives and is not restarted, so a database that comes back with pending
migrations keeps serving against a stale schema. `docs/runbook.md:125-130` already prescribes the
manual remedy — this is a posture change, not a new hazard.

## 3 — Send a redirect nowhere but this instance

`safeRedirectTarget` (`auth.server.ts:153-158`) inspects only the first two characters. A tab in
`next=` survives it, the browser strips the tab, and a visitor who typed the real password on the
real login page is sent off-origin after a successful login.

Two vectors the report does not list. Probing `Headers.set`, which is what `redirect()` does: a NUL
byte throws, and so does any non-Latin-1 path such as `/日本`, through a ByteString conversion. The
second matters for the design, because it is not a control character — a fix framed purely as
"reject control characters" leaves it live.

The corrected function rejects control characters, rejects a non-`/` prefix, rejects the `//` and
`/\` prefixes, re-resolves against an unreachable base and refuses anything whose origin moved, and
then **re-checks the resulting path for a synthesised `//`** before returning it.

Write the character class with `\u` escapes, never raw control characters. Nothing in this repo pins
line endings — no `.gitattributes`, no `.editorconfig` — and there is no linter to catch a mangled
class. A formatter normalising a literal `0x0D` inside that regex silently reopens `SEC-3` in a diff
nobody can read.

Reject rather than sanitise: the module's doc comment already states the contract in reject
vocabulary, and re-serialisation alone would turn a CRLF injection attempt into `/X-Injected:%201` —
harmless, but accepted as a path rather than refused. Keep the `//` and `/\` prefix tests even
though the origin check subsumes them; they are one line each, they cannot drift, they name the
attack, and an existing test asserts them. Do not enumerate valid routes: `app/routes.ts` imports a
devDependency absent from the runtime image, so matching means reimplementing a router that will
drift, and it inverts the module's deny-by-default posture. Route the gate's own output through the
validator so it cannot mint a return address it would refuse — and run the validator *before* the
`!== "/"` test, or the gate emits a redundant `?next=%2F`. The two constants go above the function's
doc comment, not between the comment and the symbol, and not with the module constants at the top,
which `ARCHITECTURE.md` cites by line.

Extend the hostile array with the tab vector, a leading tab, LF, a CRLF header shape, NUL, a
non-Latin-1 path, and the dot-segment vectors `/..//evil.example.com` and `/%2e%2e//evil.example.com`
— the reproducing cases for the defect review caught. Add an idempotence property over the whole
table; that single property is what surfaced the synthesis bug. Cover the POST path with a hostile
value, which nothing does today, because the hidden field is client-editable and the action must not
depend on the loader having cleaned it. Do not add `/%2f%2fevil.example` to the hostile array: the
test helper re-encodes it, so it arrives as a literal on-origin path and must be kept.

Not fixed, and the commit body should say so: `SEC-4`, where unmatched paths bypass the gate
entirely, and `holdings.tsx:118`, a second redirect sink built from request-controlled input.

## 4 — Refuse a quantity recorded under no instrument

`statement.ts:393-394` drops any row whose mapped instrument cell is blank with a bare `continue` —
no entry in `skipped`, while the adjacent absent-quantity branch records one. Driven through the
running app, uploading the repo's own `401k.csv` mapped to `Ticker` was accepted, and the instruments
step then asked about exactly one holding. Two rows worth $58,692.68 — 95.9% of a $61,200.68 file —
gone, with no notice on any screen.

The damage outlives the upload. After only the columns POST, the database held
`column_mapping → Principal → Ticker`: the broken mapping is already remembered for the institution
and will prefill every future statement from it. That settles where the fix goes, and it was
confirmed against a live database rather than reasoned about.

So the seam is the parser, not the review screen. The rule being violated is stated four lines above
the function that breaks it (`statement.ts:295`), reporting on review would leave the cure two
screens from the complaint, and by then the institution mapping has already been persisted.

The discriminator is the mapped quantity cell: a blank instrument cell whose row states a parseable
quantity is a position with no name, and anything else stays a silent skip. Walked against all six
shipped fixtures, every footer and spacer has no cell or an empty cell under the quantity column,
and `""` is in the parser's `ABSENT` set, so none is affected. Note that the CSV reader never pads
rows and the parser reads `(cells[i] ?? "").trim()`, so a short row and a present-but-empty cell are
byte-identical inputs — state the rule as the parser actually behaves, not as a distinction between
the two.

The guide contradicts itself here, and `ING-4` is that contradiction shipped.
`docs/guide/upload.md:114` promises that a row with a blank instrument is skipped silently; the very
next bullet says a skipped row is named on review "because a row that vanishes without a word would
count as sold". Both bullets change, and the new refusal belongs under the existing "The file itself
is refused" heading in `docs/guide/when-something-is-refused.md`.

`tests/statement-parse.test.ts:288-298` currently asserts the bug, using rows that state quantities.
Rewrite its fixture to genuinely empty rows so it still covers the real spacer rule, and add the
401k case as the reproducing test. `tests/column-mapping.test.ts:251-273` needs more care than
"returns problems instead of throwing": its bytes are `,100` and `,50`, which under the new rule hit
the *new* refusal — so the rule it is named for would ship uncovered. Change its fixture to a blank
instrument and an absent quantity, and add the `,100` shape as a separate test. Add "remembers
nothing for the institution when the parse refuses", which is the argument that decided the seam and
is pinned by nothing today.

The first draft claimed the now-unused `ValidationError` import would fail `typecheck`. It would
not: `tsconfig.json` sets no `noUnusedLocals` and the repo has no linter. Only the specifier goes,
for tidiness — the import line stays, because `NotFoundError` is still used.

## 5 — Say when a statement is filed behind

A statement dated before the account's current one produces a diff computed against now, shows a
"removes all N" warning, then writes without a receipt. The report is wrong about the consequence in
the mild direction: `latest_position_set` is date-bounded, so the backdated set *does* silently
rewrite the net-worth chart between its own date and the next set. History changes with no
confirmation.

Three things ship. Resolve the statement's date in `assembleDiff` and compare it against
`lastRecorded`, as one boolean on the diff. When behind, say so on review and suppress the
majority-removal tick, which today is demanded for a removal that will not happen. Change the
receipt gate so a filed-behind set gets a receipt with its own sentence.

Cut: the as-of-relative baseline redesign and the date round trip. Two reviewers independently
argued against them, and one disproved the first draft's central justification. The claim was that
an as-of baseline only removes false ticks; it also adds them. With sets at `{A,B,C}` then `{A}`, a
statement dated between them holding `{A}` goes from no tick today to
`removed.length * 2 > current.length`, that is `4 > 3`, and a tick is demanded. The round trip is
worse than cosmetic: HTML forms cannot nest, so the date control must move to a sibling GET form,
and a reader who types a date and presses *Record* without first pressing re-read commits the
previous date silently — the exact defect class `ING-1` exists to kill. Both belong in their own
spec, *make the review diff baseline the statement's own date*.

Four things the implementer must settle. The receipt gate needs a new query: "most recently
written" is `order by created_at desc, id desc`, not expressible through `latest_position_set`,
which orders by `as_of_date`; the `id desc` tiebreak is not optional, because every test runs in one
transaction and `now()` is identical for every row a test seeds. The gate change cuts both ways — a
backdated manual balance recorded after an upload would suppress a receipt that renders today, so
either make the gate a union or accept and name it. The receipt's closing count reads "now holds N
positions", counted off the named set, which for a filed-behind set is not what the account now
holds. And the doc promise that "a set the account is no longer reading gets no sentence" must be
rewritten, not preserved — it is precisely what this change breaks.

Verify by recording `holding_valued_at` for a date inside the window before the upload. After
committing a backdated statement, confirm in psql that `latest_position_set` still returns the old
set, that the window's holdings have moved, and that `holding_valued` is unchanged. Then read the
receipt sentence off the page: the finding is that no confirmation appears, and a query answering
correctly does not prove a sentence rendered. Add a before-and-after on an ordinary forward-dated
upload — every change here runs through `assembleDiff`, which every upload goes through, and the
filed-behind path exercises none of the 99% case.

## How this was checked

Postgres 16.13 stood up without Docker, migrations and demo seed run, dev server driven over HTTP.
The suite passes at 51 files and 764 tests in 22 seconds. Node is v22.22.2 against an engines floor
of 24 — the same skew the original testers ran under, and worth naming in PR 2 specifically, since
that fix concerns EventEmitter semantics under a version the project does not officially support.

`LEAD-8` was reproduced by terminating live backends, `ING-4` by walking the upload wizard and
reading the resulting rows out of the database, `SEC-1` by probing the header writer directly.

This repo's own history sets the bar: the last comparable change records that the plan went through
three adversarial review rounds before any of it was written, and that the new tests were checked by
mutation. Two rounds are folded in here. Each PR should state which mutation was tried and which
tests caught it.
