import { Form, Link, redirect } from "react-router";

import { Amount } from "~/components/amount";
import { ChartRangeControl } from "~/components/chart-range-control";
import { EmptyState } from "~/components/empty-state";
import {
  AccountBalanceIcon,
  EditIcon,
  HoldingsIcon,
  LiabilityIcon,
  RetirementIcon,
  SavingsIcon,
  UploadIcon,
} from "~/components/icons";
import { ChartEmptyNote, NetWorthChart } from "~/components/net-worth-chart";
import {
  ACCOUNT_KINDS,
  TAX_TREATMENTS,
  acceptsSetBalance,
  isOwed,
  labelOf,
} from "~/lib/account-options";
import { getAccount } from "~/lib/accounts.server";
import { lastRecorded, setBalance, type LastRecorded } from "~/lib/balances.server";
import {
  chartRangeMiddleware,
  chartWindow,
  isoDate,
  rangeDescription,
} from "~/lib/chart-range";
import { chartAnchors, chartSeries, type ChartScope } from "~/lib/chart-series.server";
import { ownerSearch, readOwnerFilter } from "~/lib/owner-filter";
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
import { accountHoldings, accountTotal, type AccountKind } from "~/lib/valuation.server";

import { getConfig } from "../../server/config.ts";

import { PriceFreshness } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";

import type { Route } from "./+types/account";

/**
 * Account details — one account's identity, its own line, and what it holds
 * (Stitch "Account Details", DESIGN.md §13). §8.1 had ruled this page out as
 * "a filtered Holdings table already is one"; §13.1 reverses that — the
 * screen carries the account's own header and valuation series, and the
 * queries are the dashboard's with one predicate added (§8.2). Nothing here
 * reads the view directly or does money arithmetic: every figure leaves
 * `valuation.server.ts` as a decimal string and enters `format.ts` as one,
 * which keeps this page's total identical to the overview's row — one
 * `sum(value)` over one view, not two. Two mock figures are deliberately not
 * drawn (the change chip, the "Today's Change" column), each argued where it
 * would have gone: §13.7 leaves out what cannot be computed honestly.
 */

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.total.accountName ?? "Account"} · Portfolio` }];
}

/** See {@link chartRangeMiddleware}'s own docstring. */
export const middleware: Route.MiddlewareFunction[] = [chartRangeMiddleware()];

export async function loader({ params, request }: Route.LoaderArgs) {
  // First and alone, because it is the gate: `accountTotal` answers null for
  // no such account, a non-id, and a closed account alike — all three are a
  // 404 rather than a page of blanks. A closed account is excluded from
  // `holding_valued` (§8.2), so rendering it would give a header of empty
  // figures with no explanation.
  const total = await accountTotal(params.accountId);
  if (total === null) throw new Response("Not found", { status: 404 });

  const today = isoDate(Date.now());
  const scope: ChartScope = { surface: "account", accountId: params.accountId };

  // The account's own anchors — its own earliest statement (spec 0008),
  // never the household's, and the observation log's latest session; see
  // `chartAnchors`'s own docstring for why. Nothing else to batch this call
  // with: unlike the Overview, this page has no manual series to await
  // beside it.
  const anchors = await chartAnchors(scope);

  const earliest = { positionSet: anchors.positionSet };

  const { resolved, controls } = chartWindow("account", {
    request,
    today,
    earliest,
    session: anchors.session,
    timeZone: getConfig().MARKET_TIMEZONE,
  });

  // The upload flow's landing receipt (`?uploaded=<setId>`, brief §6.5).
  // Every figure is read back from the database, never the URL: the
  // parameter names *which* set was written, so an invalid or stale value
  // yields null and no sentence — the `?recorded=` receipt's contract too.
  // Serial, deliberately (out of scope for spec 0015): it does not compose
  // with the window the way the anchors do.
  const uploadedParam = new URL(request.url).searchParams.get("uploaded");
  const receipt =
    uploadedParam === null ? null : await uploadReceipt(params.accountId, uploadedParam);

  // Created here and dropped into the `Promise.all` below, so the read runs
  // beside the others rather than queued behind them — `chartSeries` is
  // where the coverage rule (§6.3) and the dated/session choice now live,
  // once, for both surfaces. See the Overview's loader.
  const points = chartSeries(scope, resolved);

  const [account, holdings, computed, recorded, freshness] = await Promise.all([
    // Read for one field, the tax treatment: `AccountTotal` carries what a
    // figure is computed from and no more (§4.5). Safe after the gate —
    // nothing in this application deletes an account.
    getAccount(params.accountId),
    accountHoldings(params.accountId),
    points,
    // What the current figure was read from, so the set-balance panel can say
    // which day it is superseding rather than asking for a correction blind.
    lastRecorded(params.accountId),
    asOfView(getConfig().MARKET_TIMEZONE),
  ]);

  return {
    freshness,
    /**
     * The owner filter as a search string, purely for the breadcrumb to hand
     * back out (spec 0013). **Nothing on this page applies it**: an account
     * has exactly one owner, so every reader here is account-scoped and
     * takes no filter (ADR-0008). A return address, not a narrowing — hence
     * a string, read by nothing below.
     */
    owners: ownerSearch(readOwnerFilter(new URL(request.url).searchParams)),
    ...controls,
    total,
    taxTreatment: account.taxTreatment,
    holdings,
    computed,
    recorded,
    receipt,
    // Whose balance is one typed number rather than a statement (§5.2),
    // decided in the shared kind vocabulary — a route that knew which kinds
    // take a typed balance would be a second answer to a question
    // `account-options.ts` answers exhaustively. Kind alone, deliberately,
    // though `setBalance` no longer trusts kind alone: an account can hold
    // securities under a `bank` label (`createDraft` in `uploads.server.ts`
    // checks only closure, reads `kind` nowhere), and hiding the panel then
    // would leave the page no write control and nothing saying why. Mounted,
    // it earns a refusal naming exactly what is held.
    takesBalance: acceptsSetBalance(total.accountKind),
    owed: isOwed(total.accountKind),
    // Today in UTC, from the server, so the box does not open on a date the
    // reader's clock invented and the app then refuses (§4.1).
    today,
    // The date control's two boundaries, read from the validator rather than
    // guessed, so the picker and the refusal cannot drift apart.
    earliestAsOf: earliestRecordableDate(),
    latestAsOf: latestRecordableDate(),
    // The redirect after a write says which date it wrote; this confirms it
    // against the set the account is actually reading, so a hand-typed
    // `?recorded=` cannot produce a confirmation for a balance nobody
    // recorded — the message can only describe what is stored (§13.7).
    justRecorded:
      recorded !== null && new URL(request.url).searchParams.get("recorded") === recorded.asOf,
  };
}

/**
 * Record a balance. Everything this does is in `balances.server.ts`; the
 * route reads the form, hands it over, and turns the outcomes into a
 * message. A refusal comes back as fields to re-render — never a 500 — so
 * the boxes keep what was typed while the message appears beside the wrong
 * one.
 */
export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const written = await setBalance(params.accountId, values);

    // Redirect rather than render: a reload cannot re-submit the write, the
    // boxes come back empty (a fresh GET), and — the reason — the
    // confirmation is forced to describe what the database says rather than
    // what the submission claimed. The receipt keeps whatever the submitting
    // page was reading — range and owner filter: `chartRangeMiddleware`
    // writes no cookie onto a redirect, so a target dropping `range` would
    // send the followed GET to whatever the cookie last held, which another
    // tab may have moved.
    const receipt = new URLSearchParams(new URL(request.url).searchParams);
    // The previous receipt, if submitted from one — two would stack.
    receipt.delete("recorded");
    receipt.delete("uploaded");
    receipt.set("recorded", written.asOf);

    throw redirect(`/accounts/${params.accountId}?${receipt.toString()}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { errors: error.fieldErrors, values };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

/**
 * Which tile an account wears — the overview's mapping repeated, so an
 * account wears the same mark in the list and on its own page (the two
 * belong in `icons.tsx` the day a third screen needs them). Exhaustive over
 * `AccountKind`, so adding a kind fails the typecheck here. The icon never
 * stands alone — the kind is written out in the meta line below it.
 */
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

/**
 * A form's option label, minus the explanation after its dash:
 * `TAX_TREATMENTS` spells out what each treatment does to a figure, but a
 * header states what the account *is* — the explaining sentence belongs
 * where the choice is made. Cutting the tail off the shared label keeps one
 * list; a second, shorter list here is a list free to drift.
 */
function shortLabel(label: string): string {
  const [head = label] = label.split("—");
  return head.trim();
}

type Holding = Route.ComponentProps["loaderData"]["holdings"][number];

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const {
    range,
    custom,
    rangeOptions: options,
    customMin,
    customMax,
    session,
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
    freshness,
    owners,
  } = loaderData;

  const Tile = TILES[total.accountKind];
  const { known, total: counted } = total.coverage;

  // The chart takes the state as a prop rather than asking for itself: its axis
  // ticks and its accessible label are strings, not components (spec 0007).
  const masked = useMasked();

  // §8.4's rule for one account: a zero and an absence must not look alike.
  // `accountTotal` returns 0.0000 for holding nothing and for every holding
  // unpriced, and neither is a valuation — so the figure is withheld and the
  // reason written out. A $0.00 on a finance page is a claim.
  const valued = known > 0;

  const last = computed.at(-1);

  return (
    <section className="page">
      {/* Overview, not Settings → Accounts: this page is the drill-down from
          the overview's list; the settings page is the form that edits, and
          the header's Edit action is the way across. The breadcrumb carries
          the owner filter back — the one thing here that reads the parameter
          (spec 0013's round trip): everything else ignores it, an account
          having exactly one owner, but landing on the whole household's
          Overview from a row clicked on a narrowed one is how the reading
          gets lost without anybody choosing to end it. */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={{ pathname: "/", search: owners }}>Overview</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{total.accountName}</span>
      </nav>

      {/* The upload flow's receipt, in the place the thing happened. Every
          figure is the loader's — recomputed against the set the account is
          actually reading — so a hand-typed ?uploaded= can only describe
          what is stored, or nothing. No toast, no green flash: a sentence,
          until the next navigation. */}
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
          {/* The closing clause (brief §6.5): the count is the recorded
              set's own rows, read back like every figure here — never the
              URL's claim. */}
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

            <PriceFreshness freshness={freshness} />

            {/* No delta chip, though the mock has one: the honest version is
                a subtraction of two decimal strings, and the query layer has
                no per-account `netWorthChange` yet. Money arithmetic does not
                move into a route to get a chip (§8.2, §4.1) — the panel below
                draws the same movement as a line. */}
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
              {/* Without the owner filter, deliberately: the upload flow has no
                  owner concept, so there is nothing there to hand it to. */}
              <Link className="button button--quiet" to={`/upload?account=${total.accountId}`}>
                <UploadIcon />
                Upload statement
              </Link>

              {/* An anchor, not a second copy of the form: §11 makes this the
                  one write a phone is offered and it should not take a scroll
                  to reach — but two forms writing one balance is two places
                  to fix a bug. The panel stays in order; this jumps to it. */}
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

          {/* The range is a URL, so the control needs no JavaScript and a
              chosen range survives a reload — the overview's contract, key
              for key. */}
          <ChartRangeControl
            range={range}
            custom={custom}
            options={options}
            customMin={customMin}
            customMax={customMax}
          />
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
              label={`${total.accountName} ${rangeDescription(range, custom)},`}
              masked={masked}
              session={session}
            />
          ) : (
            <ChartEmptyNote session={session} points={computed.length}>
              <p className="empty-note">
                A line needs two dated points and this range holds {computed.length}. It appears
                over a wider range, or once a second statement covering this account has been
                uploaded.
              </p>
            </ChartEmptyNote>
          )}
        </div>
      </section>

      {holdings.length === 0 ? (
        <EmptyState>
          The positions this account holds are listed here, with what each is worth. Nothing has
          been recorded for this account yet —{" "}
          {takesBalance ? (
            "set its balance below and it appears."
          ) : (
            <>
              <Link to={`/upload?account=${total.accountId}`}>upload a statement</Link> for it and
              they appear.
            </>
          )}
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

          {/* Four columns, not the mock's five: "Today's Change" needs each
              instrument's previous close, which the row shape does not carry
              — `quote` is overwritten in place (§6.2) and `holding_valued`
              exposes today's price with nothing to compare against.
              Producing it would mean a hand-rolled query (§8.2's weak point)
              or subtracting decimal strings in a route. §13.7: a figure the
              schema cannot produce is left out, not invented. */}
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

      {/* Outside the panel, because the panel is not always here: a refusal
          rendered only inside `SetBalance` reaches nobody on an account
          whose kind takes no typed balance — exactly the account `setBalance`
          refuses, so the reader got a 200 and no word of why (report SET-5).
          Not a second copy: the only place `errors.form` is drawn. */}
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
 * The one write this page offers, for the kinds whose whole position is a
 * number (§5.2). A form, not the mock's "Deposit"/"Transfer" buttons — this
 * app moves no money; a family reads a figure off a banking app and copies
 * it in, and the honest control is a box holding the figure and its date.
 * The amount opens **empty**, never pre-filled: a pre-filled box turns
 * "record today's balance" into one click on a stale number, and a balance
 * silently re-asserted on a new date is indistinguishable from one that was
 * checked. The figure it replaces is stated beside the box instead.
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
          {/* Said before the click: appending rather than editing is why undo
              is free (§5.2), and a reader expecting this box to overwrite one
              number would not expect the old figure to keep standing. */}
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

      {/* Keyed on the position set the page is reading — changes on every
          write, on no refusal. That empties the boxes after a balance lands
          (a client-side redirect does not remount the route, so an
          uncontrolled input would offer the just-saved figure for a second,
          stale submission) while leaving them untouched on a refusal. */}
      <Form method="post" className="panel-form" key={recorded?.id ?? "none"}>
        <div>
          <label htmlFor="set-balance-amount">
            {owed ? "Amount owed" : "Balance"}
            <input
              id="set-balance-amount"
              name="amount"
              defaultValue={typedAmount}
              // `text`, not `number`: a number input silently drops what it
              // cannot parse, so a pasted "$14,500.00" arrives empty and the
              // family is told a balance is required. Exact parsing lives in
              // `input.server`.
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
