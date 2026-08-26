import { Form, Link, redirect } from "react-router";

import { Amount } from "~/components/amount";
import { EmptyState } from "~/components/empty-state";
import {
  AccountBalanceIcon,
  EditIcon,
  HoldingsIcon,
  LiabilityIcon,
  RetirementIcon,
  SavingsIcon,
} from "~/components/icons";
import { NetWorthChart } from "~/components/net-worth-chart";
import {
  ACCOUNT_KINDS,
  TAX_TREATMENTS,
  acceptsSetBalance,
  isOwed,
  labelOf,
} from "~/lib/account-options";
import { getAccount } from "~/lib/accounts.server";
import { lastRecorded, setBalance, type LastRecorded } from "~/lib/balances.server";
import { uploadReceipt } from "~/lib/uploads.server";
import { holdingNote } from "~/lib/holdings-view";
import { useMasked } from "~/lib/masking";
import {
  NotFoundError,
  ValidationError,
  earliestRecordableDate,
  formFields,
  latestRecordableDate,
} from "~/lib/input.server";
import {
  accountHoldings,
  accountSeries,
  accountTotal,
  firstRecordedDate,
  type AccountKind,
  type IsoDate,
} from "~/lib/valuation.server";

import type { Route } from "./+types/account";

/**
 * Account details — one account's identity, its own line, and what it holds.
 *
 * The Stitch "Account Details" screen (DESIGN.md §13). §8.1 had ruled this page
 * out on the grounds that a filtered Holdings table already is one; §13.1
 * reverses that, because the screen carries the account's own header and its own
 * valuation series, and the queries behind it are the dashboard's with one
 * predicate added rather than new joins (§8.2).
 *
 * Nothing here reads the view directly and nothing here does arithmetic on
 * money. Every figure comes out of `valuation.server.ts` as a decimal string and
 * goes into `format.ts` as one, which is what keeps this page's total identical
 * to the row the overview already shows for the same account — they are one
 * `sum(value)` over one view, not two.
 *
 * Two things the mock shows are deliberately not drawn, each argued where it
 * would have gone: the header's change chip, and the holdings table's "Today's
 * Change" column. Both are figures this app cannot compute honestly today, and
 * §13.7 is explicit that such a figure is left out rather than invented.
 */

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.total.accountName ?? "Account"} · Portfolio` }];
}

/**
 * The ranges the segmented control offers.
 *
 * Deliberately the same four the overview offers, with the same `?range=` keys
 * and the same default: the control is the same control, and a person who
 * bookmarked `?range=3m` on one page should get three months on the other. That
 * makes this a copy of the overview's sampler rather than an import — a route
 * module cannot be imported for its constants without dragging its loader along
 * — and the pair should move into a shared module the next time either changes.
 */
const RANGES = {
  "1m": { label: "1M", days: 30 },
  "3m": { label: "3M", days: 90 },
  "1y": { label: "1Y", days: 365 },
  all: { label: "All", days: null },
} as const;

type RangeKey = keyof typeof RANGES;

/** Left as a literal, not widened to `RangeKey`, so its `days` stays non-null. */
const DEFAULT_RANGE = "1y" as const satisfies RangeKey;

/** As on the overview: one round trip, twenty-five evaluations of the as-of function. */
const SAMPLES = 25;

const DAY_MS = 86_400_000;

/**
 * UTC throughout, deliberately.
 *
 * §4.1 and `valuation.server.ts` both warn about dates crossing a boundary and
 * landing a day early; `toISOString` is the one conversion that cannot pick up
 * the server's timezone on the way out.
 */
const isoDate = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

/** The dates the line is drawn from, deduped so two samples cannot land on one day. */
function sampleDates(days: number): IsoDate[] {
  const today = Date.parse(isoDate(Date.now()));
  const step = (days * DAY_MS) / (SAMPLES - 1);

  const dates = Array.from({ length: SAMPLES }, (_, index) =>
    isoDate(today - (SAMPLES - 1 - index) * step),
  );

  return [...new Set(dates)];
}

/**
 * How many days back the chart reaches.
 *
 * "All" is measured from day zero — the earliest date *any* statement records —
 * rather than from this account's own first one, which no query exposes. The
 * difference costs nothing: samples before this account existed come back over
 * zero rows, are dropped below, and the drawn line starts where the account's
 * history starts. The hand-typed pre-history plays no part, here or in the
 * chart: `manual_networth` is the household's net worth (§7), not an account's.
 */
async function windowDays(range: RangeKey): Promise<number> {
  const fixed = RANGES[range].days;
  if (fixed !== null) return fixed;

  const earliest = await firstRecordedDate();
  if (earliest === null) return RANGES[DEFAULT_RANGE].days;

  // A floor of one month keeps the sampler from collapsing to a single point on
  // an instance whose first upload was this week.
  return Math.max(Math.ceil((Date.now() - Date.parse(earliest)) / DAY_MS), 30);
}

export async function loader({ params, request }: Route.LoaderArgs) {
  // First and alone, because it is the gate. `accountTotal` answers null for an
  // id that names no account, for one that is not an id at all, and for a closed
  // one — and all three are a 404 rather than a page of blanks. A closed account
  // is excluded from `holding_valued` (§8.2), so rendering it would produce a
  // header whose every figure is empty and no explanation of why.
  const total = await accountTotal(params.accountId);
  if (total === null) throw new Response("Not found", { status: 404 });

  const requested = new URL(request.url).searchParams.get("range");
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `?range=`
  // naming anything on `Object.prototype` — `toString`, `constructor`,
  // `valueOf` — passed this gate, and `RANGES[requested].days` then read
  // `undefined` all the way to `isoDate(NaN)` and a 500 on the page. A query
  // parameter must not be able to do that.
  const range: RangeKey =
    requested && Object.hasOwn(RANGES, requested) ? (requested as RangeKey) : DEFAULT_RANGE;

  const dates = sampleDates(await windowDays(range));

  // The upload flow's landing receipt (`?uploaded=<setId>`, ingest brief
  // §6.5). Every figure in it is read back from the database, never from the
  // URL: the parameter names *which* set was written and says nothing about
  // what is in it, so an invalid or stale value yields null and no sentence —
  // the same contract the `?recorded=` receipt below already keeps.
  const uploadedParam = new URL(request.url).searchParams.get("uploaded");
  const receipt =
    uploadedParam === null ? null : await uploadReceipt(params.accountId, uploadedParam);

  const [account, holdings, series, recorded] = await Promise.all([
    // Read for one field: the tax treatment. `AccountTotal` carries what a
    // figure is computed from and no more, and a tax treatment is a fact about
    // the account rather than about its value (§4.5). Safe after the gate above
    // — nothing in this application deletes an account, so the row that just
    // answered is still there to answer again.
    getAccount(params.accountId),
    accountHoldings(params.accountId),
    accountSeries(params.accountId, dates),
    // What the current figure was read from, so the set-balance panel can say
    // which day it is superseding rather than asking for a correction blind.
    lastRecorded(params.accountId),
  ]);

  // A date before this account's first statement sums to 0.0000 over zero rows.
  // That is "nothing was recorded yet", not "the account was worth nothing" —
  // drawing it would put a fictional climb out of zero at the head of the line
  // (§7), which is why the filter is on the coverage count and not the amount.
  const computed = series
    .filter((point) => point.coverage.total > 0)
    .map((point) => ({ date: point.date, amount: point.amount }));

  return {
    range,
    total,
    taxTreatment: account.taxTreatment,
    holdings,
    computed,
    recorded,
    receipt,
    // Whose balance is one typed number rather than a statement (§5.2). Decided
    // in the shared kind vocabulary, not here: a route that knew which kinds
    // take a typed balance would be a second answer to a question
    // `account-options.ts` already answers exhaustively.
    //
    // Kind alone, deliberately, even though `setBalance` no longer trusts kind
    // alone. An account can hold securities under a `bank` label with no kind
    // change at all — `createDraft` (`uploads.server.ts:205`) checks only
    // whether the account is closed and reads `kind` nowhere — and hiding the
    // panel in that state would leave the page with no write control and
    // nothing saying why. Mounted, it earns a refusal that names exactly what
    // is held.
    takesBalance: acceptsSetBalance(total.accountKind),
    owed: isOwed(total.accountKind),
    // Today in UTC, from the server, so the box does not open on a date the
    // reader's clock invented and the app then refuses (§4.1).
    today: isoDate(Date.now()),
    // The date control's two boundaries, read from the validator rather than
    // guessed, so the picker and the refusal cannot drift apart.
    earliestAsOf: earliestRecordableDate(),
    latestAsOf: latestRecordableDate(),
    // The redirect after a write says which date it wrote, and this confirms it
    // against the set the account is actually reading. A hand-typed `?recorded=`
    // therefore cannot produce a confirmation for a balance nobody recorded —
    // the figure beside it is the loader's, so the message can only ever
    // describe what is stored (§13.7).
    justRecorded:
      recorded !== null && new URL(request.url).searchParams.get("recorded") === recorded.asOf,
  };
}

/**
 * Record a balance.
 *
 * Everything this does is in `balances.server.ts`; the route reads the form,
 * hands it over, and turns the two outcomes into a message. A refusal comes
 * back as fields to re-render — never a 500 — which is what lets the boxes keep
 * what was typed while the message appears beside the one that was wrong.
 */
export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const written = await setBalance(params.accountId, values);

    // Redirect rather than render. Three things fall out of it, and the third
    // is the reason: a reload cannot re-submit the write, the boxes come back
    // empty because this is a fresh GET rather than the same elements
    // re-rendered, and the confirmation is then forced to describe what the
    // database says instead of what the submission claimed.
    throw redirect(`/accounts/${params.accountId}?recorded=${written.asOf}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { errors: error.fieldErrors, values };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

/**
 * Which tile an account wears.
 *
 * The overview's mapping, repeated rather than shared, so that an account wears
 * the same mark in the list and on its own page; the two belong in `icons.tsx`
 * the day a third screen needs them. Exhaustive over `AccountKind` by
 * construction, so adding a kind to the schema fails the typecheck here rather
 * than rendering a page with no mark on it. The icon never stands alone — the
 * kind is written out in the meta line below it.
 */
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/**
 * A form's option label, minus the explanation after its dash.
 *
 * `TAX_TREATMENTS` spells out what each treatment does to a figure, because on
 * a form that distinction is the entire reason the column is not a boolean
 * (§4.5). A header states what the account *is*, and the sentence explaining the
 * choice belongs where the choice is made. Cutting the tail off the shared label
 * keeps one list: a second, shorter list here is a list free to drift.
 */
function shortLabel(label: string): string {
  const [head = label] = label.split("—");
  return head.trim();
}

type Holding = Route.ComponentProps["loaderData"]["holdings"][number];

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const {
    range,
    total,
    taxTreatment,
    holdings,
    computed,
    recorded,
    receipt,
    takesBalance,
    owed,
    today,
    earliestAsOf,
    latestAsOf,
    justRecorded,
  } = loaderData;

  const Tile = TILES[total.accountKind];
  const { known, total: counted } = total.coverage;

  // The chart takes the state as a prop rather than asking for itself: its axis
  // ticks and its accessible label are strings, not components (spec 0007).
  const masked = useMasked();

  // §8.4's rule, applied to one account: a zero and an absence must not look
  // alike. `accountTotal` returns 0.0000 both for an account that holds nothing
  // and for one whose every holding is unpriced, and neither is a valuation —
  // so the figure is withheld and the reason is written out instead. A $0.00 on
  // a finance page is a claim, and this is not the page to make it on.
  const valued = known > 0;

  const last = computed.at(-1);

  return (
    <section className="page">
      {/* Overview, not Settings → Accounts: this page is the drill-down from the
          overview's accounts list, which is what links here. The settings page
          for the same account is the form that edits it, and the header's Edit
          action is the way across. */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{total.accountName}</span>
      </nav>

      {/* The upload flow's receipt, in the place the thing happened: directly
          under the page's header, above the first panel. Every figure is the
          loader's — recomputed against the set the account is actually
          reading — so a hand-typed ?uploaded= can only describe what is
          stored, or nothing. No toast, no green flash: a sentence, until the
          next navigation. */}
      {receipt !== null ? (
        <p role="status">
          Recorded <b>{receipt.filename ?? "the statement"}</b>:{" "}
          {receipt.firstStatement ? (
            <>
              <span className="u-data">{receipt.counts.added}</span> added
            </>
          ) : (
            <>
              <span className="u-data">{receipt.counts.added}</span> added ·{" "}
              <span className="u-data">{receipt.counts.updated}</span> updated ·{" "}
              <span className="u-data">{receipt.counts.removed}</span> removed
            </>
          )}
          , as of <b className="u-data">{receipt.asOf}</b>.{" "}
          {/* The closing clause (brief §6.5): the count is the recorded set's
              own rows, read back from the database like every other figure in
              this sentence — never the URL's claim. */}
          {total.accountName} now holds{" "}
          <b className="u-data">{receipt.holdingCount}</b>{" "}
          {receipt.holdingCount === 1 ? "position" : "positions"}.
        </p>
      ) : null}

      <section className="panel">
        <div className="detail-header">
          <div className="detail-identity">
            <div className="account-tile">
              <Tile />
            </div>
            <div>
              <h1 className="detail-title">{total.accountName}</h1>

              {/* The colon lives in the `dt`, which is the mock's typesetting
                  and the reason a pair stays readable when the row wraps. */}
              <dl className="detail-meta">
                <div>
                  <dt>Owner:</dt>
                  <dd>{total.ownerName}</dd>
                </div>
                <div>
                  <dt>Institution:</dt>
                  {/* Optional on the form, so a blank is a real state and not a
                      missing read (`accounts.server.ts`). */}
                  <dd>{total.institution || "—"}</dd>
                </div>
                <div>
                  <dt>Kind:</dt>
                  <dd>{labelOf(ACCOUNT_KINDS, total.accountKind)}</dd>
                </div>
                <div>
                  <dt>Tax treatment:</dt>
                  <dd>{shortLabel(labelOf(TAX_TREATMENTS, taxTreatment))}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="detail-total">
            <span className="u-label">Total value</span>

            {/* No delta chip beside the figure, though the mock has one. The
                honest version of it is this account now against this account at
                the window's start, and that is a subtraction of two decimal
                strings: `netWorthChange` does exactly that for the household in
                SQL, in `numeric`, and the query layer has no per-account
                equivalent yet. Money arithmetic does not move into a route to
                get a chip (§8.2, §4.1) — the panel below draws the same movement
                as a line, from the same series such a query would sum. */}
            {valued ? (
              <>
                <p className="detail-figure u-data">
                  <Amount value={total.amount} />
                </p>
                {known < counted ? (
                  <p className="coverage-note">
                    Based on {known} of {counted} holdings. The rest have never been priced
                    and contribute nothing to this figure, or to the line below it.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="coverage-note">
                {counted === 0
                  ? "Nothing has been recorded for this account yet, so there is nothing to value."
                  : `None of this account's ${counted} holdings has ever been priced, so there is nothing to value yet.`}
              </p>
            )}

            <div className="detail-actions">
              {/* An anchor, not a second copy of the form. §11 makes this the
                  one write a phone is offered, and a phone opening this page
                  should not have to scroll a chart and a table to reach it —
                  but two forms writing one balance is two places to fix a bug
                  in. The panel stays where it reads in order; this jumps to it. */}
              {takesBalance ? (
                <a className="button button--quiet" href="#set-balance">
                  <EditIcon />
                  Set balance
                </a>
              ) : null}

              <Link className="button button--quiet" to={`/settings/accounts/${total.accountId}`}>
                <EditIcon />
                Edit details
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Performance</h2>

          {/* The range is a URL, so the control needs no JavaScript and a chosen
              range survives a reload — the same contract as the overview's, key
              for key, so the two pages behave identically. */}
          <nav className="segmented" aria-label="Chart range">
            {Object.entries(RANGES).map(([key, { label }]) => (
              <Link
                key={key}
                to={key === DEFAULT_RANGE ? "." : `?range=${key}`}
                aria-current={key === range ? "true" : undefined}
                preventScrollReset
              >
                {label}
              </Link>
            ))}
          </nav>
        </header>

        <div className="panel-body">
          {computed.length >= 2 && last ? (
            <NetWorthChart
              // Its own gradient id: two charts sharing one would both paint
              // from whichever `<defs>` the document holds first.
              id={`account-${total.accountId}`}
              computed={computed}
              // Empty, and not an oversight: the hand-typed prefix is the
              // household's net worth before day zero (§7), and attributing it
              // to one account would be inventing that account's history.
              manual={[]}
              label={`${total.accountName} over the last ${RANGES[range].label},`}
              endingAt={last.amount}
              masked={masked}
            />
          ) : (
            <p className="empty-note">
              A line needs two dated points and this range holds {computed.length}. It appears
              over a wider range, or once a second statement covering this account has been
              uploaded.
            </p>
          )}
        </div>
      </section>

      {holdings.length === 0 ? (
        <EmptyState>
          The positions this account holds are listed here, with what each is worth. Nothing has
          been recorded for this account yet —{" "}
          {takesBalance
            ? "set its balance below and it appears."
            : "upload a statement for it and they appear."}
        </EmptyState>
      ) : (
        <section className="panel">
          <header className="panel-header">
            <h2 className="panel-title">
              <HoldingsIcon />
              Holdings
            </h2>
            <span className="panel-count">
              {holdings.length} {holdings.length === 1 ? "holding" : "holdings"}
            </span>
          </header>

          {/* Four columns, not the mock's five. Its "Today's Change" needs each
              instrument's previous close, and the row shape the query layer
              returns carries no such thing: `quote` is the intraday tier and is
              overwritten in place (§6.2), and `holding_valued` exposes today's
              price and nothing to compare it against. Producing it would mean a
              hand-rolled query beside the shared one (§8.2's named weak point)
              or subtracting decimal strings in a route, and a column of dashes
              would be no better. §13.7: a figure the schema cannot produce is
              left out, not invented. */}
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="is-numeric">
                    Quantity
                  </th>
                  <th scope="col" className="is-numeric">
                    Price
                  </th>
                  <th scope="col" className="is-numeric">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  // Unique by construction: a position set holds one row per
                  // instrument (`holding_one_row_per_instrument`).
                  <tr key={holding.instrumentId}>
                    <td>
                      <div className="cell-stack">
                        {/* No badge for an instrument with no public ticker — a
                            401k trust or a hand-entered fund. A placeholder in a
                            ticker-shaped chip reads as a ticker. */}
                        {holding.symbol ? <span className="badge">{holding.symbol}</span> : null}
                        <div>
                          {holding.instrumentName}
                          <span className="cell-sub">{holdingNote(holding)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="is-numeric">
                      <Amount value={holding.quantity} shape="quantity" />
                    </td>
                    {/* Null price and null value are the same holding: never
                        quoted. A dash says so; a zero would understate the
                        account by the whole position and look deliberate. */}
                    <td className="is-numeric">
                      <Amount value={holding.price} />
                    </td>
                    <td className="is-numeric">
                      <Amount value={holding.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Outside the panel, because the panel is not always here. A refusal
          rendered only inside `SetBalance` reaches nobody on an account whose
          kind takes no typed balance — and that is exactly the account
          `setBalance` refuses, so the reader got a 200, an unchanged page and
          no word of why nothing was recorded (report `SET-5`). Not a second
          copy: this is the only place `errors.form` is drawn. */}
      {actionData?.errors?.form ? (
        <p className="form-error" role="alert">
          {actionData.errors.form}
        </p>
      ) : null}

      {takesBalance ? (
        <SetBalance
          accountName={total.accountName}
          owed={owed}
          recorded={recorded}
          today={today}
          earliestAsOf={earliestAsOf}
          latestAsOf={latestAsOf}
          errors={actionData?.errors}
          values={actionData?.values}
          justRecorded={justRecorded}
          amount={total.amount}
          valued={valued}
        />
      ) : null}
    </section>
  );
}

/**
 * The one write this page offers, for the two kinds of account whose whole
 * position is a number (§5.2).
 *
 * It is a form and not a button pair: the mock's "Deposit" and "Transfer" move
 * money between accounts, which this application cannot do and has nothing to
 * do it with. What a family actually does is read a figure off a banking app
 * and copy it in, and the honest control for that is a box holding the figure
 * and the date it was true on.
 *
 * The amount deliberately opens **empty** rather than pre-filled with the
 * current balance. A pre-filled box turns "record today's balance" into one
 * click on a stale number, and a balance that is silently re-asserted on a new
 * date is indistinguishable from one that was checked. The figure it is
 * replacing is stated beside the box instead, where reading it is the reader's
 * decision.
 */
function SetBalance({
  accountName,
  owed,
  recorded,
  today,
  earliestAsOf,
  latestAsOf,
  errors,
  values,
  justRecorded,
  amount,
  valued,
}: {
  accountName: string;
  /** Whether what is typed becomes a negative quantity (§2). */
  owed: boolean;
  recorded: LastRecorded | null;
  today: string;
  /** The earliest date the validator accepts. */
  earliestAsOf: string;
  /** The furthest-ahead date the validator accepts. */
  latestAsOf: string;
  errors?: Readonly<Record<string, string>>;
  values?: Record<string, string>;
  /** A write on this page's own last request, confirmed against the database. */
  justRecorded: boolean;
  /** The account's total, from the loader — the figure the confirmation quotes. */
  amount: string;
  /** False when nothing is priced, in which case there is no figure to quote. */
  valued: boolean;
}) {
  // What was typed wins over the default, so a refusal never costs the entry.
  // Empty after a successful write, because that arrives as a fresh GET.
  const typedAmount = values?.amount ?? "";
  const asOf = values?.asOf ?? today;

  return (
    <section className="panel" id="set-balance">
      <header className="panel-header">
        <h2 className="panel-title">Set balance</h2>
      </header>

      <div className="panel-body form-intro">
        <p className="form-note">
          {owed ? (
            <>
              What is still owed on {accountName}, as a plain amount — it counts against the
              household, and the minus sign is added when it is stored.
            </>
          ) : (
            <>What {accountName} holds, as of the day it held it.</>
          )}{" "}
          {/* Said before the click, not after it. Appending rather than editing
              is why undo is free (§5.2), and a reader who expects this box to
              overwrite one number would not expect the old figure to keep
              standing on its own date. */}
          Recording a balance never overwrites an earlier one: each is kept on its own date, and
          the most recent is the one every figure is computed from.
        </p>

        {justRecorded && recorded !== null ? (
          <p className="form-note" role="status">
            Recorded. {accountName} now reads{" "}
            {valued ? (
              <b className="u-data">
                <Amount value={amount} />
              </b>
            ) : (
              "no valuation"
            )}{" "}
            as of{" "}
            {recorded.asOf}.
          </p>
        ) : null}
      </div>

      {/* Keyed on the position set the page is reading, which changes on every
          write and on no refusal. That is what empties the boxes after a
          balance lands — a client-side redirect does not remount the route, so
          an uncontrolled input would otherwise keep the figure that was just
          saved and offer it for a second, stale submission — while leaving them
          untouched when the write was refused. */}
      <Form method="post" className="panel-form" key={recorded?.id ?? "none"}>
        <div>
          <label htmlFor="set-balance-amount">
            {owed ? "Amount owed" : "Balance"}
            <input
              id="set-balance-amount"
              name="amount"
              defaultValue={typedAmount}
              // `text`, not `number`. A number input silently drops what it
              // cannot parse, so a pasted "$14,500.00" arrives as an empty
              // string and the family is told a balance is required. The
              // parsing this app wants is exact and lives in `input.server`.
              type="text"
              inputMode="decimal"
              placeholder="14,500.00"
              aria-invalid={errors?.amount ? true : undefined}
              autoComplete="off"
            />
          </label>
          {errors?.amount ? (
            <p className="field-error" role="alert">
              {errors.amount}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="set-balance-as-of">
            As of
            <input
              id="set-balance-as-of"
              name="asOf"
              type="date"
              defaultValue={asOf}
              min={earliestAsOf}
              max={latestAsOf}
              aria-invalid={errors?.asOf ? true : undefined}
            />
          </label>
          {errors?.asOf ? (
            <p className="field-error" role="alert">
              {errors.asOf}
            </p>
          ) : (
            <p className="form-note">
              {recorded === null
                ? "Nothing has been recorded for this account yet."
                : `Currently reading the ${
                    recorded.source === "manual" ? "balance set" : "statement"
                  } for ${recorded.asOf}.`}
            </p>
          )}
        </div>

        <button type="submit" className="button">
          Record balance
        </button>
      </Form>
    </section>
  );
}
