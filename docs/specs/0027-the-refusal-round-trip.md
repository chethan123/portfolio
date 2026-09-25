# 0027 — The refusal round trip: `refused()` on the server, `<FieldError>`/`<FormError>` in the browser

_Candidate 2.5 of [the second architecture review](../research/2026-09-24-architecture-review.md)
(card 5 of its [visual companion](../research/2026-09-24-architecture-review/report.html)), closing
the first review's [§2.5 and §2.6](../research/2026-08-23-architecture-review.md) and reopening its
§4.5 on the two legs that expired. Line numbers below were read at `ec03f55`._

**What to build:** `app/lib/input.server.ts` owns the refusal *type* (`ValidationError`,
`FORM_ERROR`, `FieldErrors`, `parseInput`, `formFields`), and nothing owns the *round trip* that
turns one into a re-rendered form. So each route spells it: ten actions destructure
`const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors` (eleven sites, counting
`upload/review.tsx`'s `StaleReviewError` branch), ten of them under a near-copy of one comment. Four
return `error.fieldErrors` wholesale, two index `error.fieldErrors[FORM_ERROR]`, and one joins
`error.message`. The same `<p className="field-error" role="alert">` / `<p className="form-error"
role="alert">` paragraph is open-coded at 42 sites, and two files keep a local helper for it.

Add `refused(error, values)` beside `parseInput`, returning `{ errors, formError, values }`, the
split done once, with its argument written once. Actions spread their own fields onto it. Add
`app/components/error-message.tsx` exporting `<FieldError>` and `<FormError>`, which render exactly
today's markup. Fold every refusal paragraph and both local helpers into them. Move the shared
`refusalOf` test helper to `tests/support/refusal.ts`.

Worth doing on its own for three reasons. The split and its argument stop being copied. The markup
gets asserted once. And ARCHITECTURE.md §11.3's live debt, "two settings routes never render a
form-level refusal", closes by calling the helper rather than by a sixth hand-written split:
`settings/accounts.tsx` and `settings/account.tsx` start rendering a `form`-keyed refusal the way
every other settings form does, on the argument the first review quotes for `settings/tax.tsx`
(2026-08-23 review `:229-235`: "close to unreachable, which is exactly why it must not be the case
that goes unrendered"; the comment itself has since left `tax.tsx`). Nothing else a household sees changes: every
refusal keeps the same words, the same field and the same markup, and §7 proves it.

**Blocked by:** Nothing.

**Status:** ready-for-agent

**Out of scope:**
- The "typed wins over stored" default-value precedence open-coded in
  `settings/{people,tax,prices,display,instruments,account}.tsx`. A separate finding.
- Any change to `parseInput`, a Zod field shape, a refusal's wording, or which field a refusal is
  keyed to.
- Candidate 2.9 (`resumeAt`, the wizard's step-to-redirect translation, `?stale=true`) and 2.11
  (the lock's admission reader).
- The ceremony error flow in `settings/passkeys.tsx` and `unlock.tsx`, beyond the markup sites
  §2 names.
- The tracked `.orig` files (including `tests/commit-upload.test.ts.orig`, which defines an
  eighteenth `refusalOf` that vitest never runs), the leftover
  `docs/specs/ingest/screenshots/0024-*.png`, and any ARCHITECTURE.md line this change does not move.

## 1. `refused()`

In `app/lib/input.server.ts`, directly after `parseInput`:

```ts
export function refused(
  error: ValidationError,
  values: Record<string, string>,
): { errors: FieldErrors; formError: string | null; values: Record<string, string> }
```

It returns `errors` (every key of `error.fieldErrors` except `FORM_ERROR`), `formError`
(`error.fieldErrors[FORM_ERROR] ?? null`) and `values` (passed through unchanged).

- **Takes a `ValidationError`, never `unknown`.** Routes still write
  `if (error instanceof ValidationError)` themselves, so `refused()` cannot swallow anything that
  is not a refusal. `RefusedUpload` and `StaleReviewError` are subclasses and pass as they are.
- **`values` is `Record<string, string>`**, the type `formFields` returns. `upload/review.tsx`
  passes `withoutTicks(values)`, which has the same type. No generic: no caller needs a narrower
  type.
- **Spread onto, never conformed to.** The first review's §4.5 found that ten action payloads do
  not fit one shape, and that leg still stands. `refused()` supplies three keys, and every action
  keeps the others it returns today (`intent`, `personId`, `saved`, `preview`, `applied`,
  `problems`, `problemFields`, `diff`, `confirmationReset`, `closeError`). There is no payload type
  a route must satisfy, no hook, no context, and no wrapper around an action.

**The one comment.** The argument is written once, above `refused()`. It restores the sentence that
the first review's §4.5 quoted from `settings/people.tsx:52-55` and that has since dropped out of
every copy:

```ts
// The split, done once: an element can't pick `form` out itself, since `FORM_ERROR` is a `.server`
// value. Actions are stripped from the client bundle, so this is the right side of the line.
// Spread onto, never conformed to: action payloads don't share one shape (2026-08-23 review §4.5).
```

All ten copies are deleted, not replaced by citations: once there is no destructure, there is
nothing left to explain. They are `settings/people.tsx:40`, `settings/tax.tsx:31`,
`settings/prices.tsx:36`, `settings/display.tsx:51`, `settings/instruments.tsx:43` (variant),
`upload.tsx:59` (variant), `upload/columns.tsx:242`, `upload/accounts.tsx:66`,
`upload/instruments.tsx:108` and `upload/review.tsx:165`. At `ec03f55`, `settings/people.tsx:40`
reads the same as the others. The extra sentence the brief names exists only in the first review's
quotation, and it comes back here.

## 2. The element pair

New file `app/components/error-message.tsx`. It imports nothing from `app/lib`; §5 has the proof.

```tsx
export function FieldError({ id, message }: { id?: string; message: string | null | undefined })
export function FormError({ message }: { message: string | null | undefined })
```

| Element | `message` | Renders (as `renderToStaticMarkup` prints it) |
|---|---|---|
| `FieldError` | `"M"`, no `id` | `<p class="field-error" role="alert">M</p>` |
| `FieldError` | `"M"`, `id="x"` | `<p id="x" class="field-error" role="alert">M</p>` |
| `FormError` | `"M"` | `<p class="form-error" role="alert">M</p>` |
| either | `null`, `undefined` or `""` | nothing |

Attribute order is today's source order (`id`, `className`, `role`); React prints attributes in
prop order, and `tests/routes/account.test.ts:678` and `tests/routes/settings-tax.test.tsx:22`
match on it. `message` is a string rather than children, for two reasons. Every converted site
renders one string expression. And the element holds the absent-message check, so a site written
`{x ? <p …>{x}</p> : null}` becomes `<FieldError message={x} />`. Sites whose condition says more
than "a message exists" keep their own condition around the element: `errorActive` in `tax.tsx`
and `account.tsx`, the `form-note` else-branches in `review.tsx` and `account.tsx`, and wrapper
`div`s. `key` goes on the element where the paragraph had one.

The elements assume no refusal context. They take a string and draw a paragraph, which is why
passkeys' client-side `note` and the wizard's stale and problem messages can use them too. There is
no `FORM_ERROR`, no `FieldErrors` lookup by name, and no `errors` prop.

One behavioural edge: an empty-string message now renders nothing. `holdings.tsx:939` tests
`errors?.form === undefined`, `:796` tests `!== undefined` and `upload/accounts.tsx:139` tests
`question.stale !== null`, so at those three sites an empty message would have drawn an empty
paragraph. `stale` is the router's sentence (`uploads.server.ts:643`, `:728`), which is never
empty. No refusal message is empty. `ValidationError`'s
messages come from literal sentences, and the masked guard's is a literal.

### The 42 paragraph sites (plus two new ones)

`field-error`, 21 sites:

| # | Site | Becomes |
|---|---|---|
| F1 | `components/account-fields.tsx:28-33` (`Error_`) and its six uses (:48, :63, :83, :103, :123, :141) | `Error_` deleted; each use `<FieldError message={errors?.name} />` (and so on per field) |
| F2 | `upload/columns.tsx:314-318` | `<FieldError message={errors?.[field]} />` |
| F3 | `upload/columns.tsx:416` (in `problems.map`) | `<FieldError key={index} message={message} />` |
| F4 | `upload/columns.tsx:450-454` | `<FieldError message={errors?.costBasisIs} />` |
| F5 | `upload/accounts.tsx:139-143` | `<FieldError message={question.stale} />` |
| F6 | `upload/accounts.tsx:168-172` | `<FieldError message={errors?.[field]} />` |
| F7 | `upload/instruments.tsx:124-129` (`fieldError`) and its eight uses (:185 `kind-`, :216 `instrumentId-`, :243 `symbol-`, :262 `name-`, :289 `priceSource-`, :310 `classificationId-`, :325 `newClassificationName-`, :345 `newClassificationAssetClass-`) | helper deleted; each use `` <FieldError message={errors?.[`instrumentId-${index}`]} /> `` (and so on); `invalid` (:131) stays |
| F8 | `upload/review.tsx:551-553` | ternary kept (its else is a `form-note`); true branch `<FieldError message={errors?.asOf ?? diff.asOfError} />` |
| F9 | `upload.tsx:151-155` | `<FieldError message={errors?.accountId} />` |
| F10 | `upload.tsx:172-176` | `<FieldError message={errors?.file} />` |
| F11 | `settings/prices.tsx:93-97` | `<FieldError message={error} />` |
| F12 | `settings/people.tsx:110-114` | `<FieldError message={errors?.name} />` |
| F13 | `settings/people.tsx:175-179` | `<FieldError message={errorsFor("create")?.name} />` |
| F14 | `settings/display.tsx:154-158` | `<FieldError message={error} />` |
| F15 | `settings/tax.tsx:89-93` | `{errorActive ? <FieldError id="capital-gains-rate-error" message={error} /> : null}` |
| F16 | `settings/instruments.tsx:273-277` | `<FieldError message={errors?.instrumentId} />` |
| F17 | `settings/passkeys.tsx:787-791` (client `note`) | `<FieldError message={note} />` |
| F18 | `holdings.tsx:939-943` | `<FieldError id="revise-error-form" message={errors?.form} />` |
| F19 | `holdings.tsx:954-963` (in `messages.map`) | `` <FieldError key={field} id={`revise-error-${field}`} message={message} /> ``; the map, its fixed order and the `form-note` else unchanged |
| F20 | `account.tsx:560-564` | `{amountErrorActive ? <FieldError id="set-balance-amount-error" message={errors?.amount} /> : null}` |
| F21 | `account.tsx:580-583` | ternary kept (its else is a `form-note`); true branch `<FieldError message={errors.asOf} />` |

`form-error`, 21 sites:

| # | Site | Becomes |
|---|---|---|
| E1 | `components/price-freshness.tsx:57` | **untouched** (below) |
| E2 | `components/price-freshness.tsx:65-68` | **untouched** (below) |
| E3 | `upload/columns.tsx:339-343` (`staleReviewMessage`) | `<FormError message={staleReviewMessage} />` |
| E4 | `upload/columns.tsx:410-414` | `<FormError message={actionData?.formError} />`; the wrapper at :408 kept |
| E5 | `upload/accounts.tsx:109-113` (`staleReviewMessage`) | `<FormError message={staleReviewMessage} />` |
| E6 | `upload/accounts.tsx:115-119` | `<FormError message={actionData?.formError} />` |
| E7 | `upload/instruments.tsx:149-153` (`staleReviewMessage`) | `<FormError message={staleReviewMessage} />` |
| E8 | `upload/instruments.tsx:155-159` | `<FormError message={actionData?.formError} />` |
| E9 | `upload/review.tsx:513` (`staleReviewMessage`) | wrapper `div` and its condition kept; inside, `<FormError message={staleReviewMessage} />` |
| E10 | `upload/review.tsx:521` (`formError`) | wrapper `div` and its condition kept; inside, `<FormError message={formError} />` |
| E11 | `upload/review.tsx:686-692` (in `blocked.problems.map`) | `<FormError key={…same key…} message={problem.message} />` |
| E12 | `upload.tsx:115-119` | `<FormError message={actionData?.formError} />` |
| E13 | `settings/prices.tsx:69-73` | `<FormError message={actionData?.formError} />` |
| E14 | `settings/people.tsx:80-84` (`removalRefusal`) | `<FormError message={removalRefusal} />` |
| E15 | `settings/display.tsx:122-126` | `<FormError message={actionData?.formError} />` |
| E16 | `settings/tax.tsx:64-68` | `<FormError message={actionData?.formError} />` |
| E17 | `settings/instruments.tsx:187-191` | `<FormError message={actionData?.formError} />` |
| E18 | `settings/passkeys.tsx:486-490` (client `note`) | `<FormError message={note} />` |
| E19 | `settings/account.tsx:126-130` (`closeError`) | `<FormError message={actionData?.closeError} />` |
| E20 | `account.tsx:434-438` | `<FormError message={actionData?.formError} />` (payload change, §3) |
| E21 | `unlock.tsx:301` | **untouched** (below) |

New, the §11.3 fix:

| # | Site | Renders |
|---|---|---|
| N1 | `settings/accounts.tsx`, the add form: first child of `<Form className="panel-form">`, before `<AccountFields>` | `<FormError message={actionData?.formError} />` |
| N2 | `settings/account.tsx`, the save form: first child of `<Form className="panel-form">`, before `<AccountFields>` | `<FormError message={actionData?.formError} />` |

Placement follows the house precedent and the stylesheet. The single-purpose settings forms put
their form-level refusal first inside the `.panel-form` (`tax.tsx:64`, `prices.tsx:69`, and
`display.tsx:122`, after only hidden inputs). `people.tsx:80` and `instruments.tsx:187` render theirs
above a list of per-row forms instead, which does not match a single form's shape. And
`app/app.css:2866` and `:2894` style `.panel-form > .form-error` as a direct child. The close form
keeps its own refusal beside its checkbox (E19). A save refusal never lands there, and a close
refusal never lands at the top of the save form.

**The three left untouched, and why:**

- **`price-freshness.tsx:57`, `:65-68`.** These are not refusals, and there is no form. They report
  a refresh's outcome from a fetcher to `/refresh`, and `:65`'s children are a sentence plus a
  conditional clause, not one string. The class is borrowed for its look. `<FormError>` would call
  them something they are not, and widening its props to children for these two lines would make
  the element more general than any refusal needs.
- **`unlock.tsx:301`.** The `role="alert"` sits on a wrapping `div` that renders empty before any
  refusal exists, because a live region first met already full is commonly not announced (the
  comment at `:293`). The paragraph inside has no role. `<FormError>` always carries the role, so
  using it would either nest two alerts or need a `role` switch that only this one site uses. It
  stays as written. Its payload does change (§3).
- **`holdings.tsx:940` and `:955`** are *not* untouched. They use `<FieldError>`, as F18 and F19.
  What stays is the order: the brief (`docs/design/holdings-ui-brief.md:643-645`) requires `.field-error`
  paragraphs "in a fixed order: the form-level one first, then Quantity, then Cost basis". That
  order is built by `messages` (`holdings.tsx:789-800`), and it and its filter are left as they are.

## 3. The catch sites

Sixteen `instanceof ValidationError` sites, every one inside an `action`, plus `upload/review.tsx`'s
`StaleReviewError` branch.

| # | Site | Today | After | On screen |
|---|---|---|---|---|
| C1 | `upload/columns.tsx:241` | split + `problems: [], problemFields: []` | `{ ...refused(error, values), problems: [] as string[], problemFields: [] as string[] }` | nothing changes |
| C2 | `upload/accounts.tsx:65` | split | `refused(error, values)` | nothing changes |
| C3 | `upload/instruments.tsx:107` | split | `refused(error, values)` | nothing changes |
| C4 | `upload/review.tsx:164` | split + `values: withoutTicks(values), diff, confirmationReset` | `{ ...refused(error, withoutTicks(values)), diff, confirmationReset: crypto.randomUUID() }` | nothing changes |
| C4′ | `upload/review.tsx:154` (`StaleReviewError`) | split, same extras | `{ ...refused(error, withoutTicks(values)), diff: error.diff, confirmationReset: crypto.randomUUID() }` | nothing changes |
| C5 | `upload.tsx:58` | split | `refused(error, values)` | nothing changes |
| C6 | `settings/prices.tsx:35` | split | `refused(error, values)` | nothing changes |
| C7 | `settings/people.tsx:39` | split + `intent, personId` | `{ intent, personId: personId ?? null, ...refused(error, values) }` | nothing changes |
| C8 | `settings/display.tsx:50` | split + `saved: false as const` | `{ saved: false as const, ...refused(error, values) }`; the Set-Cookie comment at :54 stays | nothing changes |
| C9 | `settings/accounts.tsx:36` | wholesale `{ errors: error.fieldErrors, values }` | `refused(error, values)` | **a `form`-keyed refusal now renders (N1)**; field refusals unchanged |
| C10 | `settings/tax.tsx:30` | split | `refused(error, values)` | nothing changes |
| C11 | `settings/instruments.tsx:42` | split + `preview: null, applied: null` | `{ preview: null, applied: null, ...refused(error, values) }` | nothing changes |
| C12 | `settings/passkeys.tsx:163` | joined `error.message` | **unchanged, deliberately not a caller** (below) | nothing changes |
| C13 | `settings/account.tsx:37` | close: `closeError: error.fieldErrors[FORM_ERROR]`; save: wholesale | `const refusal = refused(error, values);` close: `{ saved: false, errors: undefined, formError: null, values: undefined, closeError: refusal.formError }`; save: `{ saved: false, ...refusal, closeError: undefined }`; success (:35) unchanged | **save: a `form`-keyed refusal now renders (N2)**; close unchanged (E19) |
| C14 | `holdings.tsx:203` | wholesale | **unchanged, deliberately** (below) | nothing changes |
| C15 | `account.tsx:171` | wholesale; component reads `errors.form` (:434) | `refused(error, values)`; E20 reads `formError` | nothing changes: the same message in the same `.form-error` paragraph, and `SetBalance` never read `form` |
| C16 | `unlock.tsx:82` | `{ formError: error.fieldErrors[FORM_ERROR] ?? null }` | `{ formError: refused(error, fields).formError }` | nothing changes: field-keyed refusals are still dropped, as today |

C16 builds `errors` and `values` only to throw them away. It is still preferred over
`error.fieldErrors.form ?? null`, because that would spell the key a second time outside
`input.server.ts`, and the key is the thing this change stops routes spelling. That is the
trade.

A few notes on the table:

- **Why C13's close payload carries `formError: null`.** A component reads the union of every
  payload its action returns. TypeScript normalises a union of object literals, so a member without
  the key reads as `formError?: undefined`, but only when some plain literal member states the key.
  A key that arrives only through the `...refusal` spread does not count, and
  `actionData?.formError` fails with TS2339 (checked under tsc 5.9.3). So the close literal states
  `formError: null`, and the success literal stays as it is. C9's other payload is `null`, which
  `?.` already covers. The comment at `:38` ("Close
  POST carries no account fields…") stays on the close branch.
- **After the change, `FORM_ERROR` appears in no route as a value.** `settings/account.tsx` and
  `unlock.tsx` drop it from their imports, and so do the ten split routes. The only mention left
  under `app/routes` is the comment at `settings/passkeys.tsx:164`.
- **`settings/passkeys.tsx:165` is deliberately not a caller.** Its refusals include a
  `label`-keyed one that must reach the reader, and the ceremony's `ActionData` (`:42-51`) carries
  one `formError: string` into a `useFetcher` and has no per-field slots. `refused()` would put the
  label refusal in `errors`, where nothing reads it, and a label refusal would go silent. Joining
  `error.message` is the right payload for a form with one message line. Its two render sites (E18,
  F17) still use the elements.
- **`holdings.tsx:203` keeps the wholesale payload, deliberately.** This is the surviving leg of the
  first review's §4.5: "every route that splits `formError` renders `.form-error`; the two that keep
  the key in the map render `.field-error`. Splitting there would work against the brief." The
  editor reads one ordered map (`["form", "quantity", "costBasisPerShare"]`, `:792`), and the masked
  guard at `:187-190` writes `form` into the same map. Splitting it only to re-merge it in the
  component adds a step and changes two action-data assertions
  (`tests/routes/holdings.test.ts:546`, `tests/routes/masked-holdings-correction.test.tsx:235`)
  for no visible gain. Holdings uses the elements (F18, F19); its payload stays.

## 4. The two local helpers

- **`account-fields.tsx`'s `Error_` (`:28-33`)** is deleted. Its six uses become `<FieldError
  message={errors?.<name>} />` (F1). `AccountFields` keeps `errors?: FieldErrors` (type-only import,
  `:3`) and still renders only named fields. The form-level refusal is the route's to render (N1,
  N2), as the first review's §2.5 put it: "Nothing changes in `account-fields.tsx`" beyond the
  element.
- **`upload/instruments.tsx`'s `fieldError` (`:124-129`)** is deleted, and its eight uses become
  `<FieldError message={errors?.[…]} />` (F7). Its sibling `invalid` (`:131-132`) computes
  `aria-invalid`, not markup, and stays.

No third helper is added beside them. The elements are the one helper.

## 5. The `.server` line

- `app/components/error-message.tsx` imports nothing but React's JSX runtime, implicitly. It has no
  `import` from `~/lib/*` at all, not even `import type`. Its props are plain strings. Acceptance
  checks this with `grep -n '^import' app/components/error-message.tsx`, which must return nothing,
  or at most a type-only React import. (Amended 2026-09-25: the unanchored `"import"` also matches
  the header comment's word "imports".)
- `refused()` lives in `input.server.ts`. It is called only inside `action` functions, which React
  Router's Vite plugin strips from the client bundle along with their now-unused imports. The same
  already holds for `ValidationError` and `formFields`, which every one of these routes imports as
  a value today. Acceptance checks the calls with `grep -rn "refused(error" app`: every hit must be
  inside an `action` body. A plain `grep "refused("` also hits `app/lib/statement.ts:330` and
  `:354`, calls of a file-local `const refused = (): ParsedStatement =>` (`:290`) that builds a parse outcome.
  That is a name collision, not a near-copy: it builds no form payload.
- `account-fields.tsx` keeps its `import type { FieldErrors }`, which is erased.
- **The gate is `npm run build`.** It is the only check that exercises the plugin, and neither
  `typecheck` nor `test` fails if a `.server` value reaches the client. It runs at the end of
  ticket 1, before any route changes, and again at every gate after.

## 6. Tests

**The shared `refusalOf`.** The brief says eighteen files. There are eighteen definitions in
seventeen runnable files plus one tracked `.orig` that vitest never runs. They are not one helper:

- **Group A, one body and eleven files; only the failure message differs.** The signature is
  `(run: () => Promise<unknown>): Promise<ValidationError>`. The files are
  `tests/account-lock.test.ts:50`, `revise-position.test.ts:15`, `set-balance.test.ts:13`,
  `commit-upload.test.ts:40`, `upload-draft.test.ts:25`, `multi-account-upload.test.ts:110`,
  `instrument-resolution.test.ts:71`, `upload-form.test.ts:21`, `instrument-aliases.test.ts:31`,
  `lock.test.ts:130` and `review-revision.test.ts:81`.
- **Group B, one body and three files.** The signature is
  `(action: Promise<unknown>): Promise<Record<string, string>>`, and it returns a copy of
  `fieldErrors`. The files are `tests/settings.test.ts:23`, `people.test.ts:22` and
  `accounts.test.ts:33`.
- **Three other helpers that share the name and stay local:**
  - `tests/column-mapping-form.test.ts:47` is synchronous.
  - `tests/journeys/dated-upload-baseline-orderings.test.ts:753` catches `RefusedUpload |
    StaleReviewError` and returns the typed subclass.
  - `tests/routes/upload-accounts.test.ts:111` has no `catch` at all. It narrows a route outcome
    that is not a `Response`.
  - Folding any of them in would widen the shared helper's signature for one caller each.

New `tests/support/refusal.ts` exports Group A's helper:

```ts
export async function refusalOf(run: () => Promise<unknown>): Promise<ValidationError>
// failure message: "Expected a refusal, and there was none."
```

- **Group A's eleven files** delete their local definition and import the shared one. No call
  site changes. The `ValidationError` import is dropped wherever the helper was its only use: every
  file except `lock.test.ts` and `commit-upload.test.ts`. Nothing would fail if it stayed, since
  there is no `noUnusedLocals` and no lint, but a dead import is still a drive-by left behind.
- **Group B's three files** delete theirs and import the shared one (dropping a dead
  `ValidationError` import the same way), and each call site changes
  mechanically from `await refusalOf(X)` to `(await refusalOf(() => X)).fieldErrors`. The call
  sites are `settings.test.ts` ×8, `people.test.ts` ×2 and `accounts.test.ts` ×17, excluding each
  definition. `toEqual` on `fieldErrors` behaves like it does on the old copy.
- The per-file messages ("…the upload to be refused…") are lost. They were only ever read on a
  failing test, and the stack names the file.
- After the change, `grep -rln 'function refusalOf' tests` returns `tests/support/refusal.ts` and
  the three local helpers above, and nothing else except the out-of-scope `.orig`.

**One element test file**, `tests/error-message.test.tsx`, beside the other component tests
(`tests/lock-now-control.test.tsx`). It uses `renderToStaticMarkup` and whole-string `toBe` (amended 2026-09-25: "no `id` attribute" and "nothing" are provable only on the whole string; the house rule against whole strings guards route tests from attribute churn, which this file exists to absorb), has no DOM,
and opens with a comment naming its risk. Four `it`s:

1. A field refusal with an `id` renders `<p id="x" class="field-error" role="alert">M</p>`, the
   `id` an input's `aria-describedby` names.
2. A field refusal without an `id` renders `<p class="field-error" role="alert">M</p>`, and no `id`
   attribute at all.
3. A form refusal renders `<p class="form-error" role="alert">M</p>`.
4. An absent message renders nothing, for `null`, `undefined` and `""`, for both elements.

**`tests/routes/settings-tax.test.tsx` keeps placement only.** Its `:21-23` whole-paragraph
assertion, `'<p id="capital-gains-rate-error" class="field-error" role="alert">'`, moves to the
element test as item 1. It is replaced by `toContain('id="capital-gains-rate-error"')`, which
checks that the paragraph the input names is present, next to the existing `aria-describedby` and
`aria-invalid` regex at `:24-26`, which is unchanged. Its `it` sentence is unchanged. This is the
one existing test this change edits. The proof that tax's paragraph did not move is the element
test plus §8's byte comparison.

**The §11.3 reproducing tests**, one per route, in a new
`tests/routes/settings-account-form-refusal.test.tsx`:

- No real input produces a `form`-keyed refusal on the add form or on the save form. (The close
  form's refusal is `form`-keyed, `accounts.server.ts:353-357`, and already renders, E19.)
  `accountInput` is a flat `z.object` with no `superRefine`. `requireOwner` is keyed `ownerId`.
  The duplicate-number refusal is keyed `externalAccountNumber` (`:219-224`). `updateAccount`'s kind
  refusals are keyed `kind` (`:282`, `:298`). See `accounts.server.ts:226-233`, `:260-329` and
  `:371-380`.
- So the file uses the repo's existing partial-mock idiom (`tests/routes/unlock-error-boundary.test.ts:7-15`,
  which lives in its own file because `vi.mock` is file-wide):
  - `vi.mock("~/lib/accounts.server", async (importOriginal) => ({ ...actual, createAccount:
    reject, updateAccount: reject }))`, where `reject` throws
    `ValidationError.form("Nothing was saved: the test refused the whole form.")`.
  - It then imports both routes dynamically after setting `DATABASE_URL`.
  - The mock also rewires `tests/support/fixtures.ts:10`'s import of `updateAccount`. That import
    is used by `renumber` (`:224-238`), which this file must not call. `seedAccount` inserts raw
    rows and is unaffected. The file's header says so.
  - It seeds through `withDatabase`'s fixtures (`seedPerson`, `seedAccount`), posts through
    `args(post(…))`, and renders with `renderRoute` and the real loader's data.
- Two `it`s:
  1. "renders a refusal that names no field above the add-account form, rather than saying nothing".
     This is `settings/accounts.tsx`. The markup contains `<p class="form-error" role="alert">Nothing
     was saved: the test refused the whole form.</p>`.
  2. "renders a refusal that names no field above the account's save form, rather than saying
     nothing". This is `settings/account.tsx` with no `intent`. Same assertion. It also asserts that
     `actionData.closeError` is undefined, so the refusal did not land at the close checkbox.
- Both fail on `ec03f55`, and the ticket records that output before the fix.

**Existing tests that assert paragraph markup pass unchanged**, which proves the move did not
change what renders:

- `tests/routes/account.test.ts:677-682`.
- `tests/routes/masked-holdings-correction.test.tsx:252-261`.
- `tests/routes/settings-instruments.test.tsx:152`, `:183` and `:212`.
- `tests/routes/unlock.test.ts:423` (`<div role="alert">`).
- `tests/routes/upload-wizard.test.ts:323`, `:365`, `:414`, `:464` and `:1097`. These are weaker
  checks: they assert only `role="alert"`, not the paragraph, so they pass whatever the class.
- `tests/journeys/dated-upload-baseline-orderings.test.ts` asserts no paragraph markup; its hit at
  `:429` is a comment. It must pass unchanged anyway.
- Action-data assertions pass unchanged too: `tests/routes/holdings.test.ts:546` and
  `masked-holdings-correction.test.tsx:235`, because holdings' payload is untouched, and
  `tests/routes/settings-account.test.ts:34-53`, because the close payload keeps `errors: undefined`,
  `values: undefined` and a string `closeError`.
- The one exception is `settings-tax.test.tsx`, changed as above.

## 7. Documentation this change moves

- **`ARCHITECTURE.md` §11.3.** Delete two bullets: "Two settings routes never render a form-level
  refusal…" (`:2336-2339`) and "`<FieldError>` is open-coded at roughly fifteen sites." (`:2342`).
  Add one sentence after the remaining review bullet: the review's §2.5 and §2.6 closed with spec
  0027. "Logic stranded in route module bodies" stays.
- **Appendix A, the `input.server.ts` row (`:2419`).** Add `refused()`: "…the shared field shapes,
  `refused()`, the one split of a refusal into per-field messages and the form-level one that every
  action spreads its own fields onto, and the one phrase-builder…".
- **Appendix A, the `app/components/` table.** Add a row for `error-message.tsx`: the refusal
  paragraphs' markup, once. Browser-safe, taking a string rather than a `ValidationError`, because
  the split happens server-side in `refused()`.
- **`docs/specs/README.md`.** The row for 0027, which already landed with this spec.

Appendix A's `tests/support/` table is not touched. It introduces itself as "the four modules every
test is written through", and a four-line catch helper is not one of those, just as `review.ts` and
`webauthn.ts` are not. The file's own header documents it.

§4.3 does not describe where the split happens, and §7.1's table still holds as written ("the
route's `catch`"), so neither changes. The research documents are records and stay as they are.

## 8. Differential validation

The claim is that no refusal moved. For every action that can refuse, render the refused response on
`origin/main` (`ec03f55`) and on the branch, then compare the markup byte for byte, with nothing
normalised.

**Setup**, from the checkout, with `S` as the scratchpad:

1. `git worktree add "$S/wt-main" ec03f55`, then `git worktree add "$S/wt-branch" <branch head>`.
   Symlink the checkout's `node_modules` into each, since there is no dependency change.
2. The harness is a set of untracked files, `$S/differential/*.test.tsx`, copied into each
   worktree's `tests/differential/` and never committed.
   - It imports only what exists on both trees: route modules, `tests/support/{database,routes,render}.ts(x)`
     and `withDatabase`'s fixtures. It does not import `tests/support/refusal.ts`.
   - Every harness file sets `process.env.DATABASE_URL = TEST_DATABASE_URL` before it imports a
     route, as every test file does, and calls `afterAll(closeTestDatabase)`.
   - The wizard cases need `tests/routes/upload-accounts.test.ts`'s file-local `stage`,
     `seedHousehold` and `answer`, and the upload-wizard tests' equivalents. Copy them into the
     harness, since they are not in `tests/support`.
   - Each case seeds, posts the refused submission through the route's `action(args(post(…)))`
     (or `postFile` or `chunked` for the drop screen), loads the page through the route's own
     `loader`, and renders with `renderRoute(Component, path, loaderData, { actionData, masked })`.
   - It writes the markup to `$DIFF_OUT/<case>.html`, and the action data to
     `$DIFF_OUT/<case>.json` for information.
   - For each case, reuse the inputs of an existing test that already posts that refusal wherever
     one exists.
3. Ids must match across runs, and sequences survive rollback. So before each tree's run,
   `docker compose -f compose.test.yaml down` and then `up -d --wait` for a fresh database. Then
   run, serially, the same file list in the same order: `DIFF_OUT=$S/out-main npx vitest run
   tests/differential` inside `wt-main`, and the same with `out-branch` inside `wt-branch`.
   Both runs must fall on the same UTC day. `account.tsx`'s `today` and `latestRecordableDate()`
   reach `min`/`max` attributes, so a run that crosses midnight between trees gives a false
   difference. Nothing else in the rendered markup is time- or random-dependent:
   `confirmationReset` reaches only React `key`s (`review.tsx:426`, `:467`), and unlock's `options`
   reach only an effect.
4. `diff -r "$S/out-main" "$S/out-branch"`, excluding `*.json`. Then run it again including
   `*.json`, as an informational record of payload shape changes.

**Cases.** Each case needs at least one refusal keyed to a field and, where the domain can produce
one, one keyed to `form`. Cases marked *mock* use a separate harness file with the partial
`vi.mock` from §6, because `vi.mock` is file-wide.

| Route | Field-keyed | Form-keyed |
|---|---|---|
| `settings/people` | create with a blank name; rename with a blank name | remove a person who owns an account |
| `settings/tax` | `capitalGainsRate: "1,5"` | *mock* `saveCapitalGainsRate` (`settings.server.ts:29`) → `ValidationError.form` |
| `settings/prices` | a cadence out of range | — |
| `settings/display` | an unknown `maskingPolicy` | — |
| `settings/instruments` | an alias change to an unknown instrument | an alias change after its preview went stale ("not an alias any more") |
| `settings/accounts` | a blank name; a duplicate account number | *mock* `createAccount` → `ValidationError.form` (**expected difference**) |
| `settings/account` | save with a blank name; a refused kind change | close without ticking (`closeError`); *mock* `updateAccount` → `ValidationError.form` (**expected difference**) |
| `holdings` | a bad quantity; a bad cost basis | the row gone stale under the editor; the masked POST (rendered masked) |
| `account` (`/accounts/:id`) | `amount: "1,5"`; a bad `asOf` | a balance set on a closed account (`balances.server.ts:137-141`; `tests/set-balance.test.ts:372`) |
| `upload` (drop) | no account chosen; no file | a chunked upload over the cap (`tests/routes/upload-drop.test.ts:160`) |
| `upload/columns` | a mapping missing a required column | a `headerRow` that is not in the file (`parseMappingForm`, `column-mapping.server.ts:175`, called at `columns.tsx:223`, before `rememberMapping` at `:226`); and, if it is postable, a mapping for a different kind of upload (`rememberMapping`, `uploads.server.ts:395-404`; `tests/column-mapping.test.ts:436`) |
| `upload/accounts` | an unanswered number | a form drawn over numbers the file no longer asks about (`tests/routes/upload-accounts.test.ts:270`) |
| `upload/instruments` | a malformed symbol | a stale form (the route's own `ValidationError.form`, `upload/instruments.tsx:92`) |
| `upload/review` | — (its `asOf` field refusal comes from the diff, not the catch) | a `RefusedUpload` (a baseline or filed-behind refusal); a `StaleReviewError` |
| `unlock` | — | a garbage assertion |
| `settings/passkeys` | a bad label (JSON only: the fetcher's `note` is client state that `renderRoute` cannot reach) | — |

**Expected result.** Exactly two `.html` files differ, the two *mock* form cases for
`settings/accounts` and `settings/account`'s save. Each differs only by the added `<p
class="form-error" role="alert">…</p>` as the first child of the form. Any other difference is a
defect. The `.json` comparison is expected to differ only in C9, C13 and C15's payload keys
(`formError` added, `form` moved out of `errors`) and in the random `confirmationReset`.

**Run, 2026-09-25.** The harness posted 35 refused submissions across the 16 catch sites, plus
passkeys as JSON only. It ran twice on `ec03f55`, each time on a fresh database, and the two
outputs were byte-identical, which proves it deterministic. Vitest has to run with `--no-cache`:
its file order otherwise comes from a shared timing cache, and that order decides the ids.

Three rows of the table above turned out to be unrenderable, and were dropped:
- **A balance set on a closed account.** The action refuses, but the loader 404s a closed account.
- **Holdings' "row gone stale under the editor".** Once the statement drops the row, the row is not
  drawn, so neither is its editor. Holdings' `form` case is the masked POST.
- **A mapping for a different kind of upload.** The route builds its mapping from the draft's own
  scope, so no post can make it misfit.

In their place, `/accounts/:id` gets a form-keyed case: a bank account whose statement lists
securities (`balances.server.ts:154`).

Comparing `ec03f55` with the branch head, exactly two `.html` files differed:
`settings-accounts--mock-form` and `settings-account--mock-form`. Each gained only
`<p class="form-error" role="alert">…</p>` as the first child of its form. The `.json` files
differed only in C9, C13 and C15 (`formError` added; `form` moved out of `errors`). The harness
pins `crypto.randomUUID`, so `confirmationReset` did not differ.

**In the running app.** Run the dev server over `scripts/seed-demo.ts` data. With Playwright, capture
one refused screen per form, before (on `wt-main`) and after (on the branch):

- People (a blank name).
- Tax (`1,5`).
- Prices (a cadence out of range).
- Display.
- Instruments (an alias change with a stale preview).
- Accounts (a duplicate number).
- Account (close with holdings present).
- Holdings (a bad quantity, checking the order).
- The wizard's columns, accounts and instruments steps.
- Unlock.

The captures go into `docs/specs/refusal-round-trip/screenshots/0027-*.png`, a PR-lifetime
directory (`docs/README.md:41`), deleted once the pull request merges. 0027 has no ticket
directory, so the slice directory is created only for them. They are driven by a throwaway script
in the scratchpad, which borrows `scripts/capture-screenshots.ts`'s launch and unlock-grant setup.
That committed script retakes the committed images. Refusal walks exist only to prove this change,
so they do not belong in it.

## Acceptance

**The helper**
- [ ] `refused(error: ValidationError, values: Record<string, string>)` in `app/lib/input.server.ts`
  returns `{ errors, formError, values }`, with the one comment of §1 above it.
- [ ] `grep -rn 'Split here, not in the component' app` returns nothing.
- [ ] `grep -rn '\[FORM_ERROR\]' app/routes` returns nothing.
- [ ] `grep -rn 'FORM_ERROR' app/routes` returns only `settings/passkeys.tsx`'s "Joins every refused
  field" comment (`:164` before the change, `:165` after it, because the element import lands
  above it; amended 2026-09-25).
- [ ] Every catch site matches §3's "After" column. `holdings.tsx:203` and
  `settings/passkeys.tsx:165` are unchanged.

**The elements**
- [ ] `app/components/error-message.tsx` exports `FieldError` and `FormError` with §2's props, and
  imports nothing from `app/lib`.
- [ ] `grep -rn 'className="field-error"\|className="form-error"' app` returns only
  `components/price-freshness.tsx` (×2), `routes/unlock.tsx:301` and `components/error-message.tsx`
  (×2).
- [ ] `Error_` and `fieldError` no longer exist (`grep -rnE 'Error_|const fieldError\b' app` returns nothing).

**§11.3**
- [ ] `settings/accounts.tsx` and `settings/account.tsx`'s save form render a `form`-keyed refusal
  as their form's first child. Each has a reproducing test that failed on `ec03f55`.

**Tests**
- [ ] `tests/support/refusal.ts` exports `refusalOf`. `grep -rln 'function refusalOf' tests` returns
  it, the three local helpers named in §6, and the `.orig`.
- [ ] `tests/error-message.test.tsx` asserts the markup of §2's table.
- [ ] `settings-tax.test.tsx` asserts placement only. The files in §6's "pass unchanged" list
  (`account.test.ts`, `masked-holdings-correction.test.tsx`, `settings-instruments.test.tsx`,
  `unlock.test.ts`, `upload-wizard.test.ts`, `dated-upload-baseline-orderings.test.ts`,
  `holdings.test.ts`, `settings-account.test.ts`) are unchanged: `git diff --stat origin/main --`
  on them is empty. Group A and Group B files change only as §6 says.

**Documentation**
- [ ] §7's edits and no others.

**Gates**
- [ ] `npm run typecheck`, `npm test` (the whole suite, with at least 2379 + the new tests passing)
  and `npm run build` are clean.
- [ ] §8's differential shows exactly the two expected differences.
- [ ] The screenshots are captured.

## Review findings rejected

Grounding review, round 1. Thirteen findings, one material: `upload/instruments.tsx`'s
`fieldError` has eight uses, not six, at other lines. The reviewer applied §1 and §3 in a scratch
copy and gated it: tsc, build, and 16 route test files all clean, and markup byte-identical under
react-dom 19.3.0.

Folded in:
- F7's count and lines, and F21's lines.
- C13's reason: only the close literal needs `formError: null`. The success literal stays as it
  is.
- The tax citation now points at the first review's quotation.
- §6's no-real-input claim is scoped to the add and save forms.
- The mock's reach into `fixtures.ts`'s `renumber`.
- Dead `ValidationError` imports are dropped.
- The two hedged differential rows are resolved (`saveCapitalGainsRate`, a closed-account balance
  set), and the protocol's gaps are filled (`DATABASE_URL`, the wizard helpers, same UTC day).
- The upload-wizard tests are named as weaker checks.
- C16's trade is stated.

Rejected:
- **Add a `refusal.ts` row to Appendix A's `tests/support/` table, or a bullet to
  `docs/developing.md:186`.** Rejected. That table introduces "the four modules every test is
  written through", and `review.ts` and `webauthn.ts` are rightly not in it. A four-line catch
  helper is not one of those modules, and its header documents it. The row planned in the first
  draft is dropped for the same reason.
- **Reuse `scripts/capture-screenshots.ts` for the refusal captures.** Partly rejected. Its launch
  and grant setup is borrowed, but the refusal walks stay in a throwaway script. The committed
  script retakes committed images, and walks that exist only to prove one PR would be dead code in
  it once the PR's screenshots are deleted.

Grounding review, round 2. One material finding: two acceptance greps could never come back clean.
`Error_|const fieldError` matched `parseInput`'s `const fieldErrors`, and `refused(` matched
`statement.ts`'s unrelated file-local `refused`. Both are fixed, and the collision is named in §5.

Folded in:
- The `upload/columns`, `account` and review-quotation citations.
- The README row is described as already landed.
- A third empty-message site (`upload/accounts.tsx:139`).
- §6's settings-tax wording now says what replaces the assertion.

The reviewer reproduced C13's tsc claim and confirmed that no other existing route test asserts a
payload the "After" column changes.

Rejected:
- **Leave `settings-tax.test.tsx` untouched, since its paragraph assertion passes unchanged
  anyway.** Rejected. The brief asks for the markup to be asserted once, against the element, with
  route tests asserting placement. Keeping a whole-paragraph assertion in one route test and not in
  the others would make that route the odd one out. The proof it gives up is carried by the element
  test and by §8's byte comparison, which covers every refusing form, tax included.

Grounding review, round 3, the last. It ran every acceptance and §5 command at HEAD and reasoned
each one to a clean result after the change. One material finding: the "unchanged test files"
acceptance item named §6's Group A and B files, which the plan edits, so it could never pass. It is
now scoped to the "pass unchanged" list.

Folded in:
- The `statement.ts` collision lines.
- `rememberMapping`'s line.
- The review quotation's span.
- The placement sentence, which had overstated the precedent: `people` and `instruments` render
  theirs above per-row forms.

Noted and left as it is: `npx vitest list` enumerates 2380 tests at HEAD, while the baseline run
reported 2379 passed. The gate reads "at least 2379 + the new tests passing", which is the number
actually observed. Grounding stopped here: three rounds is the limit, and every material finding
has been folded in.

Code review (2026-09-25). Two reviewers looked at the change, one for correctness and the bundle
line and one for standards and shape. Neither found anything blocking.

The correctness reviewer confirmed the tests catch what they should, in a scratch worktree:
- Removing N1 and N2 fails both §11.3 tests.
- Swapping `FieldError`'s `id` and `className` fails the element test and
  `tests/routes/account.test.ts:678`.
- The client bundle carries none of `parseInput`, `ValidationError`, `FORM_ERROR` or `refused(`.

Taken:
- Two Group B call sites that the mechanical rewrite left as bare `(…).fieldErrors;` statements are
  now plain `await`s.
- `tests/accounts.test.ts:383`'s comment ("settings route renders fieldErrors as-is, no form-level
  key") had become false, and is reworded to its still-true reason.
- The §11.3 tests now anchor the refusal as the form's first child rather than merely present.
- The element test uses one idiom, whole-string `toBe`.
- The mock uses plain functions, not `vi.fn`.
- The action outcome is renamed from `refused`, the helper's name, to `outcome`.
- The element header is cut to fragments.

Kept, and noted:
- `closeError` on a refused close is now `string | null` rather than `string | undefined`. Its one
  reader tests truthiness.
- The `error-message.tsx` row in Appendix A carries two clauses beyond §7's sentence, naming the
  two sites that don't use the element. They are accurate, and they answer the obvious question.
- The branch carries the spec and the change together. It lands as two commits, and the spec stands
  on its own.
