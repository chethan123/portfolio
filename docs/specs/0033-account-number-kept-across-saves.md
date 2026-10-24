# 0033 — A successful save redraws the account editor from what was stored

_Closes [#400](https://github.com/chethan123/portfolio/issues/400). Line numbers read at `5827f4b`;
library source read at react-router 7.18.4, react-dom 19.3.0, vitest 4.1.12._

**What to build:** once a successful save on Settings → account has revalidated, the save form is
redrawn from the stored account, so every box shows what was stored and the visible account number
agrees with its hidden baseline (`fromExternalAccountNumber`) again. One route change, one browser
regression test, one CI step.

**Blocked by:** Nothing.

**Out of scope:** other settings forms with the same uncontrolled-input shape; the domain's
compare-and-set (`app/lib/accounts.server.ts:354`), unchanged; the close form.

## 1. Cause

- The save action returns `{ saved: true, values: undefined }` (`app/routes/settings/account.tsx:36`),
  so the render after revalidation draws from the fresh loader (`:61-69`): baseline becomes the
  stored number.
- The number box is uncontrolled (`app/components/account-fields.tsx:130`). React rewrites its
  default; a box the user has typed in keeps its typed value. Box stays blank.
- The next save posts blank against a baseline of `Z-999`: a valid deliberate clear
  (`accounts.server.ts:354`). The number is lost.

## 2. Fix — `app/routes/settings/account.tsx`

Remount the save `<Form>` (not the close form) with a `key` that advances once per settled save:

```tsx
const navigation = useNavigation();
const [drawn, setDrawn] = useState({ after: actionData, key: 0 });
if (navigation.state === "idle" && actionData?.saved && drawn.after !== actionData) {
  setDrawn({ after: actionData, key: drawn.key + 1 });
}
// <Form key={drawn.key} method="post" className="panel-form">
```

Why each piece:
- **Remount, not `form.reset()`.** React never rewrites a `<select defaultValue>` after mount
  (react-dom `react-dom-client.development.js`, select update path), so `reset()` would put Kind,
  Owner and Tax treatment back to their mount-time values and the next save would post them. A
  remount draws every control from the fresh `values`.
- **Gated on `navigation.state === "idle"`.** React Router commits the new `actionData` with
  `navigation: loading` *before* the loaders run (`handleLoaders`), then commits fresh `loaderData`
  with `navigation: idle`, keeping the same `actionData` object (`completeNavigation`,
  `isActionReload`). Only the idle render has the stored values.
- **Keyed on `actionData` identity.** A new object per submission, so each save remounts once. A
  revalidation this form didn't cause keeps the same object: nothing remounts, pending edits stay.
- **State adjusted during render** (React's "storing information from previous renders"), not an
  effect: no painted frame of the stale form. Initial `after: actionData` means a no-JS POST
  response doesn't remount on hydration.
- **Refusals untouched.** `saved: false` never advances the key; the echo path (`:61`) is unchanged.
- Cost, accepted: keystrokes typed while a save is in flight are dropped, and focus leaves the
  button.
- Imports: `useNavigation` from `react-router`, `useState` from `react` (neither imported today).
- Comment: one line on the key, citing #400; note it relies on this route revalidating after its
  action (a `shouldRevalidate` returning false would break it). The `:110-117` comment stays.

Rejected:
- `form.reset()` in an effect: wrong for selects (above).
- Controlled number box: changes `AccountFields`, shared with the add form, and fixes one box.
- Key on the loader's number or a stored version: remounts on every revalidation, losing pending
  edits; the issue forbids it.

## 3. Regression — `tests/browser/settings-account-saves.test.ts`

Real browser, real server, real database. No new dependency: `playwright` is already a
devDependency (`scripts/capture-screenshots.ts` is the usage to copy). The worktree may have no
`node_modules`: run `npm ci` first.

Harness, in the file's `beforeAll(fn, 180_000)` / `afterAll(fn, 60_000)`:
- **Database.** On `TEST_DATABASE_URL` (`tests/support/database.ts:19`), `create database
  portfolio_browser_<random hex>`. Migrate with `applyPendingMigrations(createPool(url))`
  (`server/migrations.ts:73`, `server/db.ts:24`); the directory defaults to
  `process.cwd()/migrations`, the repo root under vitest. Seed one person and one account with no
  number through `makeFixtures(createDatabase(url))` (`tests/support/fixtures.ts:267`,
  `app/lib/db.server.ts:23`) — committed, since the server is another process. No passkey, so the
  lock is open (`app/lib/lock.server.ts:64`). In `afterAll`: `destroy()` the Kysely handle, `end()`
  the pool, then `drop database … with (force)` from the admin connection.
- **Server.** Free port from `node:net` (listen 0, read, close). Spawn
  `node_modules/.bin/react-router dev --port <p> --strictPort`, `detached: true`,
  `stdio: "ignore"` (an undrained pipe stalls Vite), env
  `{ ...process.env, DATABASE_URL: <that db>, PUBLIC_ORIGIN: "http://localhost:<p>" }` — the
  override matters, vitest sets `PUBLIC_ORIGIN=https://portfolio.local`; a developer's `.env`
  cannot override it (Vite's `loadEnv` lets `process.env` win). Ready when `GET /healthz` answers
  200, polled within the hook's budget. `afterAll`: kill the process group (`process.kill(-pid)`).
- **Browser.** `chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })`. If launch
  throws, rethrow with a message naming `npx playwright install chromium` and
  `docs/developing.md`'s Chromium paragraph (fail loudly, like `tests/support/database.ts:40-43`;
  never skip). One context; pages A and B at `http://localhost:<p>/settings/accounts/<id>`. Never
  `bringToFront()` or hide a page: a return to visible past `REENTRY_GRACE_MS` revalidates
  (`app/lib/reentry.ts`), which rebases A's baseline and fails case 1 for a reason outside the fix.

Timing: each `it` gets `60_000`. Every `expect.poll` passes `{ timeout: 10_000 }` (default is 1 s).
DOM state is read with `expect.poll` on `locator.inputValue()`. DB reads use a Kysely handle on the
browser database.

Settling a save: every successful save changes Name; it has settled when `expect.poll` of the page
`<h1>` text equals the posted Name. A refused save has settled when the Name field's error text is
visible.

Cases (one `describe`, run in order, sharing A and B):
1. **Two unrelated saves keep a number stored from another tab** — the issue's sequence:
   A types `T-1` in Account number, clears it; B sets `Z-999`, saves; A changes Name, Institution
   and Tax treatment, saves; A changes Name and Institution again, saves. After each A save
   assert: visible number `Z-999`, hidden baseline `Z-999`, DB number `Z-999`, DB name,
   institution and tax treatment equal what A last posted, and the Tax treatment select shows it.
   No reload or navigation in A.
2. **A deliberate clear after the redraw still clears** — A clears the box, changes Name, saves;
   DB number `NULL`, box blank, baseline blank.
3. **A refusal keeps the typed edits and the baseline** — A types `Q-1` in the number, blanks Name,
   saves; refused; box still `Q-1`, Name box still blank, baseline unchanged, DB unchanged.

Already covered server-side, not duplicated: deliberate clear (`tests/accounts.test.ts:499-517`),
stale edit refused (`tests/accounts.test.ts:411-443`, `tests/routes/settings-account.test.ts:94-128`).

Before the fix, case 1 must fail (box blank after the first A save). Verify against `main`'s
`account.tsx`.

## 4. CI and docs

- `.github/workflows/ci.yml`, job `check`, before **Test**: step running
  `npx playwright install --with-deps --only-shell chromium`. Comment: headless launch with no
  `channel` uses the headless shell, so the full browser is not needed.
- `docs/developing.md`: add `tests/browser/` to "Where a new test file goes" (`:184-188`) — a real
  Chromium against a spawned dev server, for what only a mounted DOM shows; qualify "There is no
  DOM" (`:217`) with the same exception. Link the existing Chromium paragraph (`:519-524`) rather
  than repeating it.
- `docs/specs/README.md`: row for 0033.

## Acceptance

- [ ] Case 1 fails on `main`'s `account.tsx`, passes with §2.
- [ ] Cases 2 and 3 pass.
- [ ] `npm run typecheck`, `npm test`, `npm run build` green.
