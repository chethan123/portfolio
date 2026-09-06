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
import { chartReach, chartSeries, type ChartScope } from "~/lib/chart-series.server";
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
 * One account's identity, its own line, and what it holds (DESIGN.md §13.1).
 * Queries are the dashboard's plus one predicate (§8.2) — same total as
 * Overview's row. Two mock figures (change chip, "Today's Change" column)
 * are left out where nothing can compute them honestly (§13.7).
 */

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.total.accountName ?? "Account"} · Portfolio` }];
}

/** Stamps the range cookie here too (spec 0008) — see {@link chartRangeMiddleware}. */
export const middleware: Route.MiddlewareFunction[] = [chartRangeMiddleware()];

export async function loader({ params, request }: Route.LoaderArgs) {
  const today = isoDate(Date.now());
  const scope: ChartScope = { surface: "account", accountId: params.accountId };

  const [total, reach] = await Promise.all([
    // Null for no such account, a non-id, and a closed account alike — all three a 404.
    accountTotal(params.accountId),
    chartReach(scope),
  ]);

  if (total === null) throw new Response("Not found", { status: 404 });

  const earliest = { positionSet: reach.positionSet };

  const { resolved, controls } = chartWindow("account", {
    request,
    today,
    earliest,
    session: reach.session,
    timeZone: getConfig().MARKET_TIMEZONE,
  });

  // Started here, not the first wave, so a 404 from the gate above never
  // strands this promise unhandled (Node drops the process on that).
  const recordedPromise = lastRecorded(params.accountId);

  // Upload flow's landing receipt (`?uploaded=<setId>`, brief §6.5) — read
  // back from the database, never the URL, so a stale value yields null.
  const uploadedParam = new URL(request.url).searchParams.get("uploaded");
  const receiptPromise =
    uploadedParam === null
      ? null
      : recordedPromise.then((recorded) => uploadReceipt(params.accountId, uploadedParam, recorded));

  const points = chartSeries(scope, resolved);

  const [account, holdings, computed, recorded, freshness, receipt] = await Promise.all([
    // Only the tax treatment — safe after the gate; nothing here deletes an account.
    getAccount(params.accountId),
    accountHoldings(params.accountId),
    points,
    recordedPromise,
    asOfView(getConfig().MARKET_TIMEZONE),
    receiptPromise,
  ]);

  return {
    freshness,
    // Breadcrumb round trip only (spec 0013) — an account has one owner, so
    // nothing else here reads this filter (ADR-0008).
    owners: ownerSearch(readOwnerFilter(new URL(request.url).searchParams)),
    ...controls,
    total,
    taxTreatment: account.taxTreatment,
    holdings,
    computed,
    recorded,
    receipt,
    // Kind alone decides, via `account-options.ts` — though `setBalance`
    // checks only closure, so a bank-labeled account can still hold
    // securities and refuse with its own message.
    takesBalance: acceptsSetBalance(total.accountKind),
    owed: isOwed(total.accountKind),
    today,
    earliestAsOf: earliestRecordableDate(),
    latestAsOf: latestRecordableDate(),
    // Confirmed against the actually-recorded set, so a hand-typed
    // `?recorded=` can't produce a confirmation nobody wrote (§13.7).
    justRecorded:
      recorded !== null && new URL(request.url).searchParams.get("recorded") === recorded.asOf,
  };
}

/** Records a balance; `balances.server.ts` owns the rule (§5.2). */
export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const written = await setBalance(params.accountId, values);

    // Redirect, not render — reload can't resubmit; confirmation reads the
    // database. Range/owner filter preserved so a stale cookie doesn't win.
    const receipt = new URLSearchParams(new URL(request.url).searchParams);
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

// Overview's tile mapping repeated — exhaustive over `AccountKind`, adding a kind fails the typecheck here.
const TILES = {
  brokerage: AccountBalanceIcon,
  "401k": AccountBalanceIcon,
  ira: RetirementIcon,
  bank: SavingsIcon,
  liability: LiabilityIcon,
} satisfies Record<AccountKind, typeof AccountBalanceIcon>;

// Option label minus the explanation after its dash — the header states
// what the account is, not what the treatment does; keeps one list.
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

  const masked = useMasked();

  // §8.4: zero and absence must not look alike — `accountTotal` returns
  // 0.0000 for both, so the figure is withheld and the reason written out.
  const valued = known > 0;

  const last = computed.at(-1);

  return (
    <section className="page">
      {/* Breadcrumb carries the owner filter back (spec 0013) — the one
          place here that reads it; an account has one owner. */}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={{ pathname: "/", search: owners }}>Overview</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{total.accountName}</span>
      </nav>

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

              <dl className="detail-meta">
                <div>
                  <dt>Owner:</dt>
                  <dd>{total.ownerName}</dd>
                </div>
                <div>
                  <dt>Institution:</dt>
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
              <Link className="button button--quiet" to={`/upload?account=${total.accountId}`}>
                <UploadIcon />
                Upload statement
              </Link>

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
              id={`account-${total.accountId}`}
              computed={computed}
              // Empty deliberately — the hand-typed prefix is the household's, attributing it here would invent history.
              manual={[]}
              label={`${total.accountName} ${rangeDescription(range, custom)},`}
              masked={masked}
              session={session}
            />
          ) : (
            <ChartEmptyNote session={session} moments={computed.length}>
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

          {/* Four columns, not the mock's five — "Today's Change" needs a
              previous close the row shape doesn't carry (§8.2, §13.7). */}
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
                  <tr key={holding.instrumentId}>
                    <td>
                      <div className="cell-stack">
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
 * The one write this page offers, for kinds whose whole position is a
 * number (§5.2). Amount opens empty, never pre-filled — a pre-filled box
 * turns "record today's balance" into one click on a stale number.
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
  owed: boolean;
  recorded: LastRecorded | null;
  today: string;
  earliestAsOf: string;
  latestAsOf: string;
  errors?: Readonly<Record<string, string>>;
  values?: Record<string, string>;
  justRecorded: boolean;
  amount: string;
  valued: boolean;
}) {
  // Typed value wins over the default, so a refusal never costs the entry.
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

      {/* Keyed on the read position set — changes on every write, none on a
          refusal, so a client-side redirect doesn't leave a stale, uncontrolled input. */}
      <Form method="post" className="panel-form" key={recorded?.id ?? "none"}>
        <div>
          <label htmlFor="set-balance-amount">
            {owed ? "Amount owed" : "Balance"}
            <input
              id="set-balance-amount"
              name="amount"
              defaultValue={typedAmount}
              // `text`, not `number` — a number input silently drops unparseable paste ("$14,500.00").
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
