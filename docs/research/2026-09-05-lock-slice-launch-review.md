# The lock slice, reviewed before launch

A launch review of the passkey lock (spec 0019, tickets 01–07, ADR-0012) against `main` at
`1ffdc6e` — the head that carries #227 through #241. Written to be picked up as work: §7 is an
ordered remediation plan, each item one pull request. Nothing here is a source of truth; the spec,
the tickets and the code stay authoritative. This document records what was checked, how, and what
the checks found.

## 1. Verdict

**Ship with conditions.** No way past the refusal and no way to mint a grant without a verified
assertion was found, by five independent adversarial passes over the middleware, the grant, both
ceremonies and the authorisation races, or by a drive of the real app in Chromium against a real
Postgres. What was found is smaller than a hole and larger than nothing: an open redirect at the
moment of unlock, a setup-state leak through one exempt path's data form, two load-bearing wirings
that a one-line regression would silently undo with the suite still green, an explicit "Lock now"
that leaves a browser's earlier grants live, and a set of documents — the family guide first among
them — that describe screens and behaviours the code does not have. Each is small, each is stated
in §3 with a reproduction, and §7 orders them. The conditions are the first five items of §7 and
one real-device check (§5, gap 6) before the household's first passkey is enrolled.

## 2. Method

- **Gates, re-run on this environment**: 88 files, 1708 tests passed; `typecheck` and `build`
  clean. Postgres 16.13 and Node 22.22 here, not the pinned 17 and 24.12 — Docker Hub pulls were
  refused by the sandbox proxy, so a local cluster stood in. Nothing in the suite depended on the
  difference, but it is a difference.
- **Ten adversarial reviewers, two per area, briefed separately** — the refusal (request side; the
  grant as bearer token), both ceremonies (verification against the installed library; the
  authorisation rules and their races), the client-side triggers (mechanics; the two late
  reversals against the authorities), the documents (ticket 07 and #240; the family guide and
  every user-facing string), and the six earlier tickets' checklists (code side; test side, with
  mutation testing). Plus one agent driving the running app in headless Chromium through a CDP
  virtual authenticator against a migrated database.
- **Every finding below was either reproduced in this review or checked against the cited source
  lines before being repeated.** Where a reviewer's reproduction is relied on, its quoted output is
  what is cited. Findings a reviewer raised that could not be made concrete are not here.
- **GitHub's own records were read**, not the brief's account of them: #240 was opened at
  15:25:31Z and merged at 15:25:53Z with no review of any kind. #241's Codex *security* review ran
  only on its opening commit `a3343ef`; its code review of the merged head `568e484` posted at
  15:52:34Z, four minutes after the merge, and left one unresolved P2. #237's Codex security review
  ran only on `731b6ba`, the opening commit; the `@codex security review` request at 14:18:05Z got
  no re-run, though the ordinary code review did see five later commits including the merge. CI on
  #237's head was green.

## 3. Findings, most severe first

Severity: **should-fix** = land before the first household enrols; **fix-later** = real, bounded,
not a launch condition; **note** = a fact worth recording. Nothing reached launch-blocker.

### F1 · should-fix — the unlock screen's return path is an open redirect

`app/lib/return-path.ts:45-61`. `safeReturn` resolves the client's `redirectTo` against a
throwaway origin and demands that origin back, then returns `pathname + search`. The WHATWG parser
collapses a leading `..` *before* appending the next empty segment, so `/..//evil.test` resolves
with the right origin and a pathname of `//evil.test`. That string is what `redirect()` is handed,
and a browser reads a scheme-relative `//evil.test` as `https://evil.test/`.

Reproduced in this review (Node 22): `/..//evil.test`, `/%2e%2e//evil.test`, `/.//evil.test`,
`/a/..//evil.test` and `/..\/evil.test` all return `//evil.test`. The request-side reviewer
reproduced it end to end on the dev server: `GET /unlock?redirectTo=/..//evil.test` → `302
location: //evil.test`, both on an open instance and on a locked one carrying a live grant; the
action path (`app/routes/unlock.tsx:185`) uses the same function, so a family member sent that
link is redirected off-site the moment they pass the passkey ceremony. The bug predates the lock
(`/masking` and `/refresh` share it) but the lock is what put it at the moment of authentication.
No loader runs and no grant is affected.

### F2 · should-fix — `/healthz.data` runs the root loader for a browser holding no grant

`app/root.tsx:367-369` exempts the path `/healthz`; `args.url` has already had `.data` stripped,
so a single-fetch request for `/healthz.data` passes to `next()`, and the framework's
`singleFetchLoaders` then runs every matched loader — root included. The root loader's neutral
branch (`app/root.tsx:487`) fires only for `/unlock`, so the full loader runs and serialises
`gated`, `firstRun`, `masked`, `maskingPolicy` and `hasPasskey`: which of the three setup states
the household is in, whether a gate fronts the instance, the masking policy. These are exactly the
fields the loader's own header says "a proven-nothing browser has no business learning", and the
header at `app/root.tsx:361-364` calls the `.data` form "harmless: that route holds no household
data" — true of the healthz loader, false of the root loader that runs beside it.

Reproduced by the request-side reviewer on a locked instance with no cookie:
`curl 'http://localhost:5181/healthz.data?_routes=root'` → 200 with `"gated",false,"firstRun",
"people","masked",true,"maskingPolicy","hasPasskey"`. Confirmed in this review against the
framework's dispatch (`node_modules/react-router/dist/development/chunk-ZA36QIGN.mjs:926-950`).
In production the Caddyfile's `handle /healthz` is exact, so `/healthz.data` is gated — the reader
is a signed-in family member without a passkey, which is the adversary ADR-0012 names. Setup
state, never a figure.

_Decided 2026-09-05, after this review: kept as it is, deliberately — the request is behind the
gate and the fields are setup state. Spec [0020](../specs/0020-the-lock-hardened.md) records the
decision; its ticket 08 corrects the comment in `app/root.tsx` that gives the wrong reason for the
same conclusion. No ticket changes the behaviour._

### F3 · should-fix — the two wirings the lock rests on are not pinned by any test

Three regressions, each one line, each leaves the suite green:

1. **`future.v8_middleware` in `react-router.config.ts:16`.** With the flag off the framework
   passes no `generateMiddlewareResponse` and the `middleware` export is ignored; the lock is gone
   and nothing notices. No test touches `createRequestHandler` or the flag — every middleware test
   calls the exported function directly through `servedThrough`. Reproduced by the request-side
   reviewer: flag off, passkey enrolled, no cookie, `GET /holdings` → `200 <h1>Holdings</h1>`.
2. **`Layout`'s effect installing `watchReentry`** (`app/root.tsx:775-779`). Every `Layout` test
   renders through `renderToStaticMarkup`, where effects never run. A reintroduced
   `if (!hasPasskey) return;` inside that effect — the exact shape three review rounds fought —
   passes typecheck and every test. The evidence that the wiring is right is a manual drive
   recorded in a commit message, not a committed test.
3. **User verification in force.** `tests/lock.test.ts:526-541` asserts the option handed to the
   library is `undefined` — that it was *not restated* — and its comment says a UV=false assertion
   "cannot" be produced without breaking the signature. The fixture already re-signs `authData`
   for `counter` and `rpID` (`tests/support/webauthn.ts:26-34`); a `flags` option is the same move.
   If the library's default ever flipped, a no-UV assertion would unlock and the test would stay
   green.

**Mutation testing** (the checklist reviewer, in a worktree, one edit at a time, reverted between
runs, single files against a private database) put nineteen deliberate breaks into the
implementation. Fifteen turned a test red for the right reason — admitting a grant-less request,
failing open on an outage, widening the exempt list, skipping the scope check, allowing challenge
replay, allowing an assertion-less enrolment while locked, minting on a bad signature, always
rolling the grant, dropping `HttpOnly`, `Secure` or `Lax`, `>=` on the grace, ignoring a non-2xx
lock response, not clearing or not deleting on `/lock-now`, an unconditional counter write. Two
were near-equivalents. **Two survived, and both are the bootstrap race's own halves:**

4. **Deleting `where not exists (select 1 from passkey)` from the bootstrap insert**
   (`app/lib/lock.server.ts:1163`) — `tests/lock.test.ts` 75 passed, `tests/lock-schema.test.ts`
   6 passed, `tests/routes/settings-passkeys.test.ts` 90 passed. The one test for the committed
   half ("refuses a bootstrap registration once another passkey landed while it was in flight",
   `lock.test.ts:906`) seeds its interloper with `bootstrap: true`, so the partial index refuses it
   and the conditional insert never decides anything. A probe with an ordinary `bootstrap: false`
   interloper — the state after "bootstrap A, enrol B, remove A" — refuses on the baseline and
   admits the assertion-less registration under the mutation.
5. **Writing `bootstrap = false` in the bootstrap insert** (`:1162`) — the same three files all
   green. `tests/lock-schema.test.ts:140` proves the index only through the raw fixture insert,
   and `lock.test.ts:1243` races the *same* credential id, so `passkey_pkey` fires first. A probe
   of two concurrent bootstrap registrations with distinct ids through `completeRegistration` lets
   one land on the baseline and both land under the mutation.

Ticket 01 and ticket 02 both say "neither is enough alone"; the suite would not notice either one
going missing. Also surviving, lower: adding `Domain=` to the grant cookie (the attribute test
checks presence of four attributes and never the absence of the fifth the `__Host-` prefix
forbids) — a browser would reject the cookie, so this fails closed. The acknowledgement and
assertion-presence refusals for removal went red only through a message regex: every such test
sends no assertion, so the passkey survives whichever check fires, and no test sends a valid
removal assertion without the acknowledgement.

### F4 · should-fix — "Lock now" leaves a browser's earlier grants live

Every verified assertion mints a grant (`app/lib/lock.server.ts:855`, `:1183`): the unlock, the
confirm-with-an-existing-passkey step of an enrolment, and every removal each replace the
browser's cookie with a fresh id and leave the previous row live for the rest of its window.
`/lock-now` deletes the one id the cookie names (`app/routes/lock-now.ts:64-75`). Reproduced by
the bearer-token reviewer with a temporary test: unlock (g1), confirm an enrolment (g2), confirm a
removal (g3), post `/lock-now` with g3 → g1 and g2 still read as live, and `servedThrough` with
`Cookie: …=g1` on `/holdings` called `next()`. A copied *older* cookie therefore survives the
explicit control the guide tells a family member to press before handing over a phone
(`docs/guide/passkeys.md:147-148`). Ticket 06's box "a request carrying the old cookie is refused"
and `lock-now.ts`'s header ("this browser's grant gone") both describe one grant per browser;
`docs/data-model.md` alone admits the old row "stays live beside the new one". Exposure needs a
copy of an `HttpOnly` cookie, which the borrowed-phone adversary does not have; the fix is small
(§7.4).

### F5 · should-fix — a hostile registration can store a poisoned or unreadable passkey row

`app/lib/lock.server.ts:1149-1154` stores `credential.id` and `credential.transports` exactly as
the library returns them, and the library returns them exactly as the client sent them: the id
comes from the attested credential data with no length check
(`@simplewebauthn/server/esm/helpers/parseAuthenticatorData.js:34-36`, only `id !== rawId` is
compared, `verifyRegistrationResponse.js:42`), and `transports` is copied verbatim
(`verifyRegistrationResponse.js:202`). The module narrows `response.id`, never the stored value.
Reproduced by the ceremony reviewer:

- `transports: "internal,hybrid"` (a string), `7`, `{}` and `null` → `TypeError: transports.join
  is not a function` out of `joinTransports` (`app/lib/lock.ts:73`), outside any `try`; the route
  rethrows non-`ValidationError`s → a 500, against the module header's "never a 500". The
  challenge is spent; nothing is written.
- A registration whose attested credential id is zero bytes → `ACCEPTED`, `storedIds: [""]`, and
  `unlockOptions()` then hands every browser `allowCredentials: [{"id":""}]`. A 1024-byte id is
  stored likewise (the specification's ceiling is 1023). A registration with `counter:
  4294967295` yields a passkey every later assertion refuses.
- `transports: [""]` stores `''` — the one value migration 0012's comment says the writer must
  refuse — and `["a,b"]` stores a comma the reader splits.

The attacker is a gate-admitted family member who has already passed `beginEnrolment` (an insider,
or the bootstrap window). What a browser does with a zero-length id in `allowCredentials` could not
be checked here; if `navigator.credentials.get()` rejects the whole call, every browser in the
household is locked out until the operator deletes the row — and the row is removable from Settings
only through an assertion whose `allowCredentials` carries the same poison.

### F6 · should-fix — a signature-counter regression tells the family "try again"

`app/lib/lock.server.ts:836-839` catches the library's counter-regression throw and answers "This
passkey could not be verified. Try again."; only `console.error` names the cause. Ticket 02's box
reads "refuses the assertion and says so, rather than being logged and ignored". A cloned
authenticator is the one signal WebAuthn gives a household that it can act on, and it reads here as
a transient failure they will retry until the idle window passes. The refusal itself is correct
and writes nothing (reproduced by the ceremony reviewer: stored 5, signed 5/4/0 → `counter "5",
lastUsedAt null, grants 0`); only the sentence is wrong.

### F7 · should-fix — cross-device unlock is promised without condition, and is conditional

The enrolment acknowledgement (`app/routes/settings/passkeys.tsx:810-814`) says every other
browser "will need its own passkey, or a cross-device unlock approved from one already enrolled";
`docs/guide/passkeys.md:116-119` says "Your browser offers a way to reach another device — usually
by scanning something". The app does its part: `allowCredentials` carries each stored transport
(`app/lib/lock.server.ts:685-731`) and `authenticatorAttachment: "platform"` constrains creation
only. Whether the QR option appears is decided by what the *registering* client reported. From
primary sources (the guide reviewer, against `w3c/webauthn`, `chromium/chromium` and
`WebKit/WebKit` at `main`): WebKit offers hybrid only when the allow list is empty or an entry
lists hybrid (`WebAuthenticatorCoordinatorProxy.mm:405-458`); Chromium's mechanism set is the
union of the allow list's transports, everything only when some entry lists none
(`authenticator_common_impl.cc:742-768`), and the phone/QR mechanism needs `hybrid` in that set.
iCloud Keychain and Google Password Manager report `{hybrid, internal}`; Chrome's macOS profile
authenticator reports none (so everything is allowed); older Safari and Android GmsCore values are
unverified. So: for a household whose passkeys come from current mainstream providers the promise
holds; for one whose first passkey reports `["internal"]` alone, no browser without a passkey can
be unlocked from another device, and the only recovery is the operator. That is the failure a
family meets on their second device, after the first enrolment has locked everyone else out.

### F8 · should-fix — documents that state things the code does not do

Each of these is a sentence a reader will act on. Verified against the code in this review unless
marked.

1. `docs/guide/passkeys.md:67-72` — "If step 4 answers with a message … most often somebody else
   enrolling the household's first passkey while you were still filling this in. Read what it
   says, then press **Continue** again." In that case step 4's POST never reaches the action: the
   household is now locked and this browser holds no grant, so the middleware refuses it
   (`app/root.tsx:407`) and the fetcher follows the redirect to the unlock screen, with no
   explanation and no return address. `BOOTSTRAP_TAKEN_MESSAGE` is thrown only in step 5
   (`lock.server.ts:1171`, `:1180`), and only if the other passkey commits between this request's
   middleware check and its insert. The messages step 4 can actually print are label refusals and
   the unreadable-submission one. This is the sentence #241's one review round rewrote, and it is
   still wrong about the likeliest cause.
2. `docs/guide/passkeys.md:30-34` — "If you want a particular screen gone *right now*, press
   **Lock now** on that device." A page rendered before the first enrolment has no such control:
   it is drawn off `hasPasskey` baked in at render (`app/root.tsx:823`, `:838`). The same
   paragraph says the screen "keeps showing those figures until it asks for something new —
   tapping through to another screen, or pulling to refresh"; `watchReentry` installs on every
   page regardless (`app/root.tsx:775-779`), so a return after sixty seconds hidden locks it with
   no tap, as the guide's own later section says.
3. `docs/guide/passkeys.md:136-138` — "on a slow connection, or with none at all, whatever was
   already on the screen can stay up longer than you would expect, until it does." There is no
   "until it does": a failed or non-2xx post logs and returns (`app/lib/reentry.ts:190-203`),
   `hiddenAt` is consumed (`:263`), nothing retries, and continued use keeps rolling the grant.
4. `docs/guide/passkeys.md:143-144` — "**Lock now**, beside **Show amounts** in the navigation".
   The neighbour reads "Hide amounts" whenever amounts are shown
   (`app/components/masking-toggle.tsx:49`), and below 1024px both controls' text is clipped to an
   icon (`app/app.css:581-590`). `docs/guide/passkeys.md:56` — "It stays greyed out": the button
   is disabled (`passkeys.tsx:850`) but no `.button:disabled` rule exists in `app/app.css` (only
   `.refresh-button:disabled`, `:3596`); it may look identical either way.
5. `DESIGN.md:838-839` — "the app carries no sign-in page, no password and no session of its own."
   This is the claim ticket 07 corrected in ARCHITECTURE.md and README.md and left here because
   the ticket declared the multi-user section "still holds". DESIGN.md now argues with itself
   (`:827` and `:1065-1067` describe the grant cookie).
6. `docs/guide/when-something-is-refused.md:79` — "Nothing in this application deletes anything."
   Removing a passkey deletes it; `settings.md` and the README were corrected, this page was not.
   `docs/guide/first-run.md:24` — a lost phone is to be reported to "whoever runs the instance —
   that is done from outside the app"; revoking a lost phone's passkey is now done in Settings →
   Passkeys, which is the slice's story 15.
7. `CONTEXT.md:150-151` after #240 — "A credential the household has enrolled". Four places use
   "credential" for what the *grant cookie* carries: `docs/adr/0002:55` ("the app's own grant
   cookie … is a credential too"), `docs/adr/0012:120`, `DESIGN.md:1067`, `lock.server.ts:191`.
   Under the glossary's own rule those now read "the grant cookie carries a passkey", which is the
   opposite of the truth (`migrations/0012_lock.sql:138-141`: the cookie "carries no claim of its
   own"). The commit's factual claim — nothing else uses "key" to mean a passkey — is true; the
   substitution's cost is the collision, not the word.
8. The idle window is 7.5–15 minutes in effect (`touchGrant` rolls only under half a window,
   `lock.server.ts:414`; reproduced in this review on Postgres 16). Flat "fifteen" where a reader
   would take it as the observed behaviour: `app/lib/reentry.ts:22`, `:86`;
   `docs/specs/0019-the-lock.md:123` ("**fifteen minutes**, extended by the requests that use
   it" — a request at minute five extends nothing). The guide's `:128-130` has the honest range;
   its `:136` "the fifteen-minute clock above" points back at it.
9. Comments describing removed behaviour: `app/root.tsx:519-527` (the re-entry effect "gates on
   the same flag" — it does not), `:751` (`askServer` for "a hidden-too-long return with no
   passkey believed enrolled" — that branch is gone), `:733-745` (argues a sibling tab must never
   delete the enrolling browser's grant while `attemptLock` two lines down does exactly that on a
   hidden-too-long return); `app/components/lock-now-control.tsx:9-10` (`rootData.locked`, a field
   that does not exist, "the same field the reentry guard gates itself on"); `tests/reentry.test.ts:3-9`
   and `:29-41` (an `assumedPasskey` parameter and a `resolveReentryCallback` that no longer
   exist); `tests/reentry.test.ts:320`, `:328` (an `askServer` never handed to `watchReentry`,
   asserted not called).
10. `app/root.tsx:262-270` claims React Router's `throwIfPotentialCSRFAttack` runs "before this
    middleware for every mutation method". It runs in `singleFetchAction` and
    `handleDocumentRequest` only (`chunk-ZA36QIGN.mjs:854`, `:1419`); a resource route such as
    `/lock-now` goes through `handleResourceRequest`, which makes no such call (`:1563-1581`,
    verified in this review). The consequence is bounded — a same-*site* sibling origin can force
    a lock, since `Lax` sends the cookie on a same-site POST — but the comment offers the check as
    the second of two reasons and it is not there.
11. `app/lib/reentry.ts:155-164` — `response.ok` "is the one answer here that actually means the
    grant is gone". Any 2xx satisfies it; a captive portal's 200 HTML does (reproduced by the
    mechanics reviewer), as would the gate's sign-in page if the provider button were not skipped.
12. `docs/specs/lock/07:117-118` and `06:72-77` require `scripts/seed-demo.ts` to seed a passkey;
    `scripts/seed-demo.ts:23-32` says it deliberately does not, and `scripts/capture-screenshots.ts:224-285`
    plants one and mints the grant instead, for a stated reason. The outcome is met; the spec is
    stale.
13. `ARCHITECTURE.md:690` cites `people.server.ts:278` for the person delete; `removePerson` is at
    `:211`. `docs/operating.md:581` — "There is no server-side session store, so there is nothing
    to revoke a single cookie against" — true of the gate, under a heading that now sits above a
    per-browser store revocable one row at a time.

### Fix-later

- **F9 — behind an expired gate session the automatic lock is a silent no-op.** The gate cookie is
  a hard seven days (spec 0019:14-15); if it lapses while a tab is hidden and the grant is still
  inside its idle window, `POST /lock-now` meets Caddy's `redir` to `/oauth2/sign_in`, which with
  `OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true"` (`compose.yaml:274`) redirects straight to Google — a
  cross-origin hop a `fetch` will not follow, so `postLockNow` logs and returns. The grant survives;
  after the sign-in bounce the reader is admitted on it. Story 12 accepts staying "unlocked as I
  was"; the exposure is at most one idle window once per seven days per device; no document says
  the trigger is defeated this way. Reasoned from source; a real gate was not available.
- **F10 — a tab opened in the background locks the whole browser the first time it is shown.**
  `watchReentry` seeds `hiddenAt` from `document.visibilityState` at mount (`app/lib/reentry.ts:253`),
  so a Cmd-click that hydrates a hidden tab starts the clock; switching to it two minutes later
  posts the lock and both tabs are refused. Reproduced by the mechanics reviewer against the
  stand-in. Ticket 06 and the guide describe a *return*; this tab never left. This is the cost
  story 4 warns makes a household turn the lock off.
- **F11 — a third bootstrap interleaving lands two passkeys.** Household holds X; browser A begins
  an assertion-authorised enrolment (`register`, `bootstrap:false`); every passkey is removed;
  browser B, seeing an open household, begins a bootstrap (`bootstrap:true`); both inserts run at
  the same instant. The partial index conflicts only flagged rows with each other and B's `not
  exists` cannot see A's uncommitted tuple, so both land and B holds an assertion-free passkey in a
  locked household — the outcome ticket 02 says is "not harmless". Reproduced at SQL level with the
  module's own statements by the authorisation reviewer (`final state: { n: 2, anyboot: true }`).
  Under autocommit the window is one statement wide and needs a stale bootstrap challenge, so it is
  narrow; but `migrations/0012_lock.sql:103-134` and ticket 01:48 say the two halves are sufficient
  together, and they are not.
- **F12 — the same-provider second passkey is a dead end on screen.** `excludeCredentials` makes
  the authenticator refuse; the screen prints the library's own "The authenticator was previously
  registered" and stays in `readyToCreate` with the label input disabled (`passkeys.tsx:794`) and
  no cancel — the exits are a reload or the two-minute TTL message. The guide's account of the
  behaviour is right; the screen is not what it prepares a reader for.
- **F13 — labels admit invisible and bidirectional-override characters.** `/[\p{Cc}]/u`
  (`lock.server.ts:944`) refuses C0/C1 only; reproduced in this review: U+200B (zero width space),
  U+2028 (line separator — the message promises "no line break") and U+202E (right-to-left
  override) all pass. Cosmetic: a blank or reversed row a sibling might remove by mistake.
- **F14 — `REGISTRATION_OPTIONS_TTL_MS` restates `CHALLENGE_TTL_MS`** in a route
  (`passkeys.tsx:509`) "because `.server.ts`", while `app/lib/lock.ts` exists for exactly this
  and already holds `LABEL_MAX_LENGTH` for the same reason.
- **F15 — `passkeys.tsx` has no `<noscript>`, and Continue renders before the capability check
  answers**; with scripting off the button does nothing, and the guide's "no button to press in the
  first place" is true only after hydration.
- **F16 — the expired-challenge message is unreachable after any later mint** (`sweepChallenges`
  deletes expired entries on every mint, `lock.server.ts:555-558`, so a stale challenge reads as
  "never issued"); spent entries count against the per-kind budget until they expire (`:529`).

### Notes

- A removal whose target vanishes between resolve and delete has already spent the challenge and
  minted a live grant for the signer; the route returns no cookie, the row sweeps on the next mint
  (reproduced by the authorisation reviewer). Harmless, against the header's intent.
- The middleware rolls the grant on the very `POST /lock-now` that deletes it (`root.tsx:411`
  before `lock-now.ts:68`); if the delete fails the orphan gets a fresh fifteen minutes, not the
  remainder. A `GET /lock-now` with a live cookie also rolls it before the framework's 400.
- An empty-valued cookie (`__Host-unlock_grant=`) counts as "carrying a grant" for the outage
  carve-out (`root.tsx:392` tests `!== undefined`); the response clears an already-empty cookie.
- With the household open, `/lock-now` clears a cookie no request carried; nothing live exists to
  clear.
- `normalizedPathname` lower-cases with `toLowerCase()`, which folds U+212A KELVIN SIGN to `k`;
  the router's `i` flag does not. `GET /unloc%E2%84%AA` is a router 404 rendered without chrome.
  Unreachable by the middleware.
- `/__manifest` answers without a grant with route ids, module paths and `hasLoader` flags. No data.
- The recovery documents never say every household browser still holds a cookie naming a deleted
  row; it is inert while no passkey exists and is cleared on the next refusal.
- `tests/reentry.test.ts:226-263` is byte-for-byte the test at `:209-224` with a different comment;
  it pins nothing about the enrolment scenario it names.
- Screenshots were retaken in #236 (`3271045`, all 22 guide images plus `docs/screenshots`), not
  after #237; the changes since are non-visual (the concealment never appeared in a static
  capture). No image of the unlock screen exists anywhere, and no document references one.
- Two of the five documents that describe the grant never state the bearer-token limit: ADR-0012
  says only "unguessable", and the family guide does not mention a copied cookie at all.

## 4. The two late reversals

Both are supported by the authorities, against the code as merged.

**Concealment removed.** No authority requires a replacement render, an overlay, or a wipe.
Ticket 06 forbids the overlay form and disclaims the wipe: "It navigates rather than covering the
page, so the server decides. A client that re-locked by drawing over the screen would leave the
figures underneath it" (06:43-44); "The guarantee is that the lock ends the reading, not that it
wipes what is already drawn" (06:62-63). Spec 0019: "Deleting the grant stops the next request; it
does not reach into pages already rendered" (0019:134-135); "the lock ends the *reading*, not every
pixel already drawn" (0019:146-147); "The trigger is still a courtesy" (0019:126-128). ADR-0012
speaks only to the server. "Navigates" is a statement of mechanism on the success path — the post
succeeds, the revalidation meets the middleware, the middleware redirects — and the code does that
(`postLockNow` → `revalidate()` → refusal → `/unlock`; the redirect-following was verified in the
router's source by the mechanics reviewer, `chunk-62JRHF6Z.mjs:2391-2396`, `:2868-2935`). On failure
the page neither navigates nor covers; 06:62-63 and 0019:126 make that a courtesy shortfall the
family guide states (F8.3 is about the one clause that overstates it).

**`hasPasskey` removed from the decision.** Both authorities state the post without a condition:
"a browser hidden longer than a **sixty second** grace **posts the lock action** when it comes
back rather than merely navigating" (0019:123-126); "on return, if the gap exceeds the grace, it
**posts the lock action** — the same route the control uses" (06:37-40). The only passkey
condition in ticket 06 is on the *control* (06:23-25). Nothing says an open household must not
post. The scenario the removal makes reachable — a tab rendered before the first enrolment, hidden
throughout it, returning after sixty seconds and deleting the grant its sibling just minted — is
browser X locking itself after the exact trigger story 3 asks for; ticket 05's "not locked out by
its own success" is scoped to "the redirect back to Settings still renders" (05:63-64), which
holds. The cost is one unlock prompt, and for a second-or-later enrolment, possibly one between its
two taps. `app/root.tsx:733-745` still argues the opposite direction for a different trigger and
should say so (F8.9).

Nothing else depended on `assumePasskeyForReentry` or `passkeyCheckFailed`: no code, CSS, script
or document references them; what remains is the stale prose in F8.9. The tests asserting the old
branch were rewritten, not left green by accident, with the one duplicate noted above. Every other
behavioural change in #237 (`git diff d94bc65 4bd55eb -- app/`) is listed and accounted for: the
plain-`fetch` `postLockNow` with `response.ok` and `keepalive`; both listeners always installed;
the cookie read before `isLocked()` and the `/lock-now` carve-out requiring the request's own
cookie (tested, `tests/routes/root.test.ts:339-436`); segment-wise path decoding behind
`normalizedPathname` (tested for `/lock-now`, not for the exempt paths).

## 5. The known gaps, judged

1. **Codex's security review never re-ran.** True of the *security* review on both PRs (§2). It
   does not block: this review covers the merged code, and the security-relevant change it named
   (the carve-out requiring the request's own cookie) is pinned by four tests and was probed
   directly here.
2. **No real device.** Still true, and it is the one gap with a launch consequence: F7. Ticket 04
   records its three device checks as unavailable, which its own words allow. Condition: before the
   household's first passkey is enrolled, enrol on the household's primary phone and confirm, from a
   second device holding no passkey, that the unlock screen offers the cross-device path and that
   it completes. If it does not, the operator's recovery is one `DELETE` away, and the acknowledgement
   copy (F7) has to say what the household actually has.
3. **Synthesised visibility and a faked clock.** Acceptable. Everything under the override is the
   real code, and the drive here observed the same (§8). A real backgrounded tab differs in one way
   the code already handles — a suspended process fires nothing, and the grant rides out its window.
4. **bfcache argued from source.** Acceptable. The HTML specification's reactivation order
   (visibility to `visible`, then `pageshow`) means both listeners run on a restore; the
   `pageshow` guard revalidates and the visibility guard posts. Not observed in a browser.
5. **Screenshots not regenerated on the final code.** Regenerated in #236, on code that is visually
   identical to the head. Not a condition.
6. **Cross-device unlock.** In scope (story 6), implemented on the app's side, browser- and
   provider-dependent on the client side, unverified on any real device, and promised without a
   condition in the one sentence a family reads before locking everyone else out. F7 and gap 2.

## 6. Ticket-by-ticket coverage

Boxes are literally unticked in every merged spec in this repository; that is convention, and each
was judged from the code and the tests. Counts are boxes; the exceptions are named.

| Ticket | Met | Letter not spirit / partial | Skipped | Not verifiable |
|---|---|---|---|---|
| 01 — schema | 24 | — | — | 3 (`db:types` provenance; `typecheck` was run here and passed) |
| 02 — ceremonies | 55 | 5: the expired-challenge message (F16); UV "in force" (F3.3); counter regression "says so" (F6); "closed by the insert rather than by the check" and "one atomic act with ticket 01's constraint" — both true of the code, neither pinned through the real path (F3.4, F3.5) | — | — |
| 03 — middleware | 28 | — | — | 1: the dev-loop cookie "having actually tried it" — a claim in a header with no artefact |
| 04 — unlock screen | 18 | 1: the client-only seam is proven by a static-import grep, not by reading the built output the ticket names (the build was run here and is clean) | — | 3: the real-device checks, recorded as unavailable per the ticket's own words |
| 05 — Settings → Passkeys | 33 | — | — | — |
| 06 — lock now / re-entry | 17 | 1: "navigates rather than covering" on the failure path (§4) | — | — |
| 07 — documents | 26 | 2: the multi-user section (F8.5); the screenshot box in letter (seed-demo, F8.12) | — | — |

Ticket 05's "warning depends on grant ownership, not on how many exist": the code checks the count
first (`passkeys.tsx:378`) for the last-passkey case the same ticket mandates, then ownership —
met. Ticket 06's "drawn only while the instance is locked at all": the loader fails toward not
drawing the control on a read error (`root.tsx:538-544`) — met, and the safer direction. CLAUDE.md's
rules: no `any`, enum, namespace or parameter property in any lock file; the one `Number()` is the
documented counter; Zod only in the domain module and `server/config.ts`; no `.server` value import
from browser-reachable code. The PRs merged in blocker order (01, 02, 03, 04, 06 and 05 within
seconds of each other, 07) and each stood alone.

## 7. Remediation plan

Ordered. Each item is one pull request that typechecks, builds and carries its own tests. The first
five are the launch conditions; "re-verify" names what has to be looked at again after each lands.

1. **Close the open redirect** (F1). In `safeReturn`, re-parse the serialised result against the
   throwaway base and refuse it unless the origin still matches — `new URL("//evil.test", BASE)`
   resolves to `evil.test` and fails. Tests: the five spellings above, on `/unlock`, `/masking`
   and `/refresh`. Re-verify: the unlock action's redirect on a normal return, and the middleware's
   own `redirectTo` round trip.
2. ~~**Keep the root loader neutral on every exempt path** (F2).~~ Declined by the owner on
   2026-09-05; see the note under F2. The comment is corrected instead (spec 0020, ticket 08).
3. **Pin the wiring** (F3). Five tests: (a) a request through the built server bundle's
   `createRequestHandler` — or a test that asserts `react-router.config.ts` exports
   `future.v8_middleware === true` at minimum — proving a locked, grant-less document request is
   refused; (b) a `Layout` render under a DOM-less effect harness, or a small extracted
   `installReentry(hasPasskey)` that a test can call with both values and assert both listeners
   install regardless; (c) a UV=false assertion, re-signed through the fixture's existing path,
   refused; (d) the in-flight test at `lock.test.ts:906` repeated with a `bootstrap: false`
   interloper, so the conditional insert is what refuses; (e) the two-connection race in
   `lock-schema.test.ts` driven through `completeRegistration` with two distinct credential ids, so
   the partial index is what refuses. Plus the small ones: `Domain` absent from the cookie; a valid
   removal assertion without the acknowledgement leaves the passkey. Re-verify: nothing — these
   add, they do not change.
4. **One live grant per browser** (F4). When a request that already carries a live grant verifies
   a new assertion — the enrolment confirm, a removal, an unlock with a stale-but-live cookie —
   delete the prior row in the same call before setting the new cookie; `removePasskey`'s cookie
   decision then has one fewer state. Test: g1 → g2 → g3 → Lock now leaves zero live rows for that
   browser; the "old cookie is refused" test extended to the older cookies. Re-verify: the removal
   route's `Set-Cookie` matrix in `tests/routes/settings-passkeys.test.ts`.
5. **Narrow what registration stores** (F5). Before the insert: `credential.id` non-empty, at most
   1023 bytes decoded, and equal to `response.id`; `transports` an array of non-empty strings
   without commas (Zod, in the domain module); refuse with a `ValidationError`. Tests: each hostile
   shape above → a printable refusal, nothing stored. Re-verify: a real registration from the
   Chromium drive still enrols; `excludeCredentials` still carries transports.
6. **Say what the family will actually see** (F8.1-4, F8.6, F9's one sentence, F10's warning, F12).
   The guide's step-4 paragraph, the "press Lock now on that device" paragraph, "until it does",
   "beside Show amounts", "greyed out"; `when-something-is-refused.md`, `first-run.md`; a sentence
   in "When it locks itself" that a sign-in bounce mid-absence leaves the browser as it was; and a
   `.button:disabled` rule so "greyed out" becomes true rather than deleted. Re-verify: the guide
   against the drive's verbatim strings (§8 carries them).
7. **Tell the family about a cloned authenticator** (F6). A distinct message for the library's
   counter-regression throw — the assertion is still refused, nothing is written — and a test on
   the sentence. Re-verify: the "bumped stored counter" test.
8. **Hedge the cross-device promise** (F7), then remove the hedge on evidence. The
   acknowledgement's `<strong>` and the guide's "Unlocking a browser" say the second device's path
   depends on the provider that made the first passkey and name the recovery; after the real-device
   check in §5.2 passes on the household's providers, the sentence can say what was observed.
9. **Bring the documents level with the code** (F8.5, F8.7-13). DESIGN.md's multi-user paragraph;
   the "credential" collision — the cheapest resolution is to say what the grant cookie carries
   ("an opaque id", never "a credential") in the four places, leaving the glossary as #240 left
   it; the three flat-fifteen sentences; the stale comments in `root.tsx`, `lock-now-control.tsx`,
   `reentry.test.ts`, and the CSRF and `response.ok` claims; tickets 06/07 on `seed-demo.ts`;
   `ARCHITECTURE.md:690`; `operating.md:581`; a sentence in the recovery documents about the
   cookies browsers still hold. No code changes; no re-verification beyond reading.
10. ~~**Do not seed the re-entry clock from a hidden mount** (F10).~~ Kept as it is by spec 0020's
    own decision: it fails toward locking, and the cost is one prompt. Told to the family in
    ticket 05; recorded beside the code in ticket 08.
11. **State the third bootstrap interleaving** (F11) — spec 0020 decided "state it": the mirror
    predicate only narrows the window and refuses a case the module names as fine, and the table
    lock needs a transaction the module deliberately does not open. Ticket 09 corrects the
    migration comment and ticket 01 of the lock slice to say what the two halves do and do not
    close.
12. **An `Origin` check on the resource-route POSTs** (F8.10's consequence) — `/lock-now`,
    `/masking`, `/refresh`: refuse a mutation whose `Origin` is present and not this instance's
    `PUBLIC_ORIGIN`, in one helper, matching what the framework does for document and single-fetch
    actions. Tests: a same-site sibling `Origin` refused; no `Origin` admitted (a plain form). Then
    the comment at `root.tsx:262-270` becomes true.
13. **The same-provider dead end** (F12), the invisible-character labels (F13), the duplicated TTL
    constant (F14), the missing `<noscript>` (F15), the unreachable expired message and the
    spent-entry budget (F16), and the duplicate test — each a small, separate change.

## 8. What was verified against the running app

Headless Chromium (Playwright 1.62, a CDP virtual authenticator: ctap2, internal transport,
resident key, user verification) against the Vite dev server and a migrated `portfolio_dev` on
Postgres 16. The script and the run's log are in [`harness/`](2026-09-05-lock-slice-launch-review/harness/).
Everything under the fake clock — `Date.now`, `performance.now` and `document.visibilityState`
overridden by an init script, `visibilitychange` dispatched by hand — is the real `watchReentry`,
the real `/lock-now`, the real middleware and a real database. Observed, verbatim where a string
matters:

| Step | Observed |
|---|---|
| S1 open household | `GET /` 200 renders the overview. Settings → Passkeys: empty note "No passkey is enrolled — this instance is not locked, and anyone who reaches it sees every figure. Enrolling one locks every other browser in the household."; panel "Add a passkey"; input labelled "Label", `maxlength="60"`; "Continue" disabled initially, after a label alone, after the tick alone, enabled after both; no Lock now control anywhere; the masking toggle reads "Show amounts". |
| S2 first enrolment per the guide | After Continue: button reads exactly `Create the passkey named "Alex's phone"`, label input disabled. After the ceremony the row sits above the form: "Alex's phone · Enrolled 5 Sep 2026 · Last used never · Bound to a single device"; the one-passkey nudge prints; cookie `__Host-unlock_grant` present, 43 characters, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, session-lived; `passkey` 1, `unlock_grant` 1. Lock now now present in the rail at 1280px and as an icon in the top bar at 400px. |
| S3 sibling tab | Same context, `/holdings` → 200, not redirected. |
| S4 fresh browser, no cookie | `GET /` → `/unlock?redirectTo=%2F`; screen: "Locked", "This browser is locked. Unlocking uses a passkey — this device's own provider, or another device this browser offers.", one button "Unlock". Probes: `/holdings` 302 → `/unlock?redirectTo=%2Fholdings`; `/holdings.data`, `/_root.data`, `/.data` → 202 single-fetch redirects; `/__manifest` 204; `/unlock`, `/Unlock`, `/unlock/`, `/UNLOCK//` → the unlock screen; `/unlock%2F..%2Fholdings` → 404; `/healthz` 200 with no cookie; `/settings/passkeys` and `GET /lock-now` → refused to `/unlock`; `POST /lock-now` with no cookie → 302 `/unlock` and **no `Set-Cookie`**. `redirectTo=//evil.test` and `/\evil.test` are refused (the `/..//` spelling of F1 was not in this probe list; it was reproduced separately). |
| S5 unlock in the fresh browser | Credential copied into its authenticator; Unlock → lands on `/`; cookie set; `unlock_grant` 2; the row now reads "Last used 5 Sep 2026". |
| S6 copied cookie | A third context with no authenticator and the first browser's cookie value → `GET /` 200, the overview. A copied live cookie works, as the design says it must. |
| S7 Lock now | Click → `POST /lock-now.data` 202 (a single-fetch redirect) → `/unlock`; `unlock_grant` 2 → 1; the cookie is gone from the context; `GET /` → `/unlock?redirectTo=%2F`; the context holding the copied cookie is refused too — one row, deleted once. |
| S8 re-entry, unlocked browser | Hidden, 30 s of skew, shown: no `/lock-now` request, grant intact, still on `/`. Hidden, a further 61 s, shown: `POST /lock-now` 302, `unlock_grant` → 0, page navigated to `/unlock?redirectTo=%2F`. |
| S9 the pre-enrolment tab | Household emptied; tab D1 rendered on the open household; tab D2 of the same context enrols "Tab two" (grant minted); D1 hidden, 61 s, shown → `POST /lock-now`, `unlock_grant` → 0, D1 on `/unlock`; D2's next navigation → `/unlock?redirectTo=%2Fholdings`. The case #237 fixed, observed; and its cost — the enrolling tab locked out of the grant it just minted, one prompt away from back in — observed with it. |
| S10 open household over the grace | Household emptied; hidden, 61 s, shown → `POST /lock-now` 302 → `/unlock` 302 → `/` 200; final URL `/`, rendering, no loop. |
| S11 second passkey, same provider | Note above the button: "First, confirm it is you with a passkey already enrolled — adding one is held to the same rule as removing one."; after the confirm assertion the button reads `Create the passkey named "Second"`; the same authenticator refuses creation and the screen prints **"The authenticator was previously registered"** (F12, the library's sentence). After the confirm step alone, `unlock_grant` went 1 → 2 with `passkey` still 1 — F4, live. |
| S12–S14 | **Did not run.** Chromium's virtual-authenticator environment allows one internal authenticator per context and the script tried to add a second for the genuinely-second passkey. Removal's three variants and its cookie matrix are pinned by `tests/routes/settings-passkeys.test.ts` (90 tests) and were run directly by the authorisation reviewer; the 60/61-character label boundary and the three direct-POST refusals were reproduced by that reviewer against the domain module; `/unlock` while already unlocked is pinned by `tests/routes/unlock.test.ts`. A real-browser pass over removal remains worth doing with a second context whose authenticator holds only the second credential. |

## 9. What could not be checked, and what it would take

- **Any real device.** iOS home-screen web apps, Android, Safari, a real password manager after
  backgrounding, and whether a locked phone fires `visibilitychange` in each. It takes the
  household's actual phones and one afternoon, and §5.2 turns it into a launch condition for the
  one promise that depends on it.
- **A real gate.** The expired-session chain (F9) and the `.data`-behind-Google error page were
  reasoned from `Caddyfile`, `compose.yaml` and oauth2-proxy's source, not run; the sandbox has no
  Docker network to stand the stack up on. It takes the compose stack with a short
  `OAUTH2_PROXY_COOKIE_EXPIRE`.
- **Browser handling of a zero-length or over-long `allowCredentials` id** (F5's worst case). It
  takes one poisoned row and Chromium, Safari and Firefox each pressing Unlock.
- **The Chromium 141 dev-loop cookie claim** in `lock.server.ts:196-205`: no artefact of the run it
  describes exists in the repository; the capture script corroborates only that Chromium *sends*
  such a cookie over `http://localhost`. Firefox and WebKit on `http://localhost` are unknown.
- **The production server.** Only the Vite dev server was driven; `react-router-serve`'s
  `OPTIONS` handling and error-body sanitisation were not.
- **Postgres 17 and Node 24.** The pinned versions were not available; the suite passed on 16 and
  22.
- **Codex's security review of the merged code.** Not this review's to run; §2 records what did
  and did not run.
