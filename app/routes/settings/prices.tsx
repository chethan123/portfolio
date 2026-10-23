import { useState } from "react";
import { Form } from "react-router";

import { Amount } from "~/components/amount";
import { FieldError, FormError } from "~/components/error-message";
import { InterpretedNumberInput } from "~/components/interpreted-number-input";
import { isoDate } from "~/lib/chart-range";
import { unitPriceRule } from "~/lib/decimal-input";
import { describeInstrument } from "~/lib/format";
import {
  ValidationError,
  earliestRecordableDate,
  formFields,
  latestRecordableDate,
  refused,
} from "~/lib/input.server";
import { backfillGaps, manualPrices, recordManualPrice } from "~/lib/prices.server";
import { readRefreshCadence, saveRefreshCadence } from "~/lib/settings.server";

import type { BackfillGap, BackfillOutcome, ManualPriceRow } from "~/lib/prices.server";
import type { Route } from "./+types/prices";

/**
 * Thin wrapper over `settings.server.ts`/`prices.server.ts` (cadence is a
 * row, not an env var — `0008_refresh_cadence.sql`). Second panel types the
 * price no feed gives (spec 0031). Third answers "why is this still unpriced"
 * (ADR-0011), listing every gap with a reason, tried or not.
 */
export function meta() {
  return [{ title: "Prices · Settings · Portfolio" }];
}

export async function loader() {
  const [refreshCadenceMinutes, manual, gaps] = await Promise.all([
    readRefreshCadence(),
    manualPrices(),
    backfillGaps(),
  ]);

  return {
    refreshCadenceMinutes,
    manual,
    gaps,
    today: isoDate(Date.now()),
    earliestAsOf: earliestRecordableDate(),
    latestAsOf: latestRecordableDate(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());
  const { intent } = values;

  try {
    switch (intent) {
      case "cadence":
        await saveRefreshCadence(values);
        // No payload — the loader re-run shows the stored cadence as confirmation.
        return null;
      case "manual-price":
        return { intent, recorded: await recordManualPrice(values, new Date()) };
      default:
        throw new Response(`Unknown intent ${JSON.stringify(intent)}.`, { status: 400 });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { intent, recorded: null, ...refused(error, values) };
    }
    throw error;
  }
}

export default function Prices({ loaderData, actionData }: Route.ComponentProps) {
  const { refreshCadenceMinutes, manual, gaps } = loaderData;
  const cadenceRefusal = actionData?.intent === "cadence" && "errors" in actionData ? actionData : null;
  const error = cadenceRefusal?.errors.refreshCadenceMinutes;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Prices</h1>
          <p className="page-subtitle">
            How often prices are fetched from the feed, the prices typed by hand for what no feed
            quotes, and what the spine does not cover yet.
            Quotes are asked for from 15 minutes before through 15 minutes after regular market
            hours; a refresh at any hour also fills in past closes for anything held further back
            than the price history reaches.
          </p>
        </div>
      </header>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Refresh cadence</h2>
        </header>

        <Form method="post" className="panel-form">
          <input type="hidden" name="intent" value="cadence" />
          <FormError message={cadenceRefusal?.formError} />

          <div>
            <label htmlFor="refresh-cadence">
              Minutes between refreshes
              <input
                id="refresh-cadence"
                name="refreshCadenceMinutes"
                inputMode="numeric"
                defaultValue={
                  error
                    ? (cadenceRefusal?.values.refreshCadenceMinutes ?? "")
                    : String(refreshCadenceMinutes)
                }
                aria-invalid={error ? true : undefined}
                aria-describedby="refresh-cadence-note"
                autoComplete="off"
              />
            </label>

            <FieldError message={error} />

            <p id="refresh-cadence-note" className="field-note">
              A whole number from 1 to 1440 — the default is 15. A lower number costs more
              requests against the feed during the quote window, from 15 minutes before through 15
              minutes after regular market hours. Outside it a refresh asks for no quotes, and
              spends a request only on the rows below that a feed can still fill — at most a
              handful per refresh, and none at all once there are none. A saved change is picked up
              when the next refresh runs, so it can take up to one old cadence to apply.
            </p>

            {/* ADR-0006, story 17 */}
            <p className="field-note">
              It is also a storage decision. Every distinct price the feed reports is kept, and
              never pruned, so the price archive grows in proportion: about a hundred instruments
              at 15 minutes is on the order of half a gigabyte a year, and one minute is roughly
              fifteen times that.
            </p>
          </div>

          <button type="submit" className="button">
            Save cadence
          </button>
        </Form>
      </section>

      <ManualPrices
        manual={manual}
        actionData={actionData?.intent === "manual-price" ? actionData : undefined}
        today={loaderData.today}
        earliestAsOf={loaderData.earliestAsOf}
        latestAsOf={loaderData.latestAsOf}
      />

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Missing price history</h2>
        </header>

        {gaps.length === 0 ? (
          <div className="panel-body">
            <p className="empty-note">
              Price history reaches back as far as every holding does. Nothing is missing.
            </p>
          </div>
        ) : (
          <>
            <div className="panel-body">
              <p className="field-note">
                These are held from a date the price history does not reach, so totals before the
                date in the third column leave them out. A refresh fills a few of them in at a
                time; a row that says why instead is one nothing can fetch.
              </p>
            </div>

            <div className="data-table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Instrument</th>
                    <th scope="col">Held from</th>
                    <th scope="col">Priced from</th>
                    <th scope="col">Last attempt</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((gap) => (
                    <tr key={gap.id}>
                      <td>
                        {gap.name}
                        {gap.symbol === null ? null : <> ({gap.symbol})</>}
                      </td>
                      <td className="u-data">{gap.firstHeld}</td>
                      <td className="u-data">{gap.firstClose ?? "—"}</td>
                      <td>{attemptWords(gap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function ManualPrices({
  manual,
  actionData,
  today,
  earliestAsOf,
  latestAsOf,
}: {
  manual: ManualPriceRow[];
  actionData: NonNullable<Route.ComponentProps["actionData"]> | undefined;
  today: string;
  earliestAsOf: string;
  latestAsOf: string;
}) {
  const refusal = actionData !== undefined && "errors" in actionData ? actionData : null;
  const recorded = actionData?.recorded ?? null;
  const [priceErrorActive, setPriceErrorActive] = useState(refusal?.errors.price !== undefined);

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Prices typed by hand</h2>
      </header>

      {manual.length === 0 ? (
        <div className="panel-body">
          <p className="empty-note">
            Nothing here is priced by hand. An instrument created with a manual price at upload
            appears here.
          </p>
        </div>
      ) : (
        <>
          <div className="panel-body">
            <p className="field-note">
              For what no feed quotes, such as a workplace plan's trust. A price carries forward
              until a later one is recorded; every earlier one is kept for history. Recording a date
              again corrects that date.
            </p>
            {recorded === null ? null : (
              <p className="form-note" role="status">
                Recorded <Amount value={recorded.price} places={4} /> for{" "}
                {describeInstrument(recorded)} as of{" "}
                <span className="u-data">{recorded.date}</span>.
              </p>
            )}
          </div>

          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Instrument</th>
                  <th scope="col" className="is-numeric">
                    Latest price
                  </th>
                  <th scope="col">Priced on</th>
                </tr>
              </thead>
              <tbody>
                {manual.map((row) => (
                  <tr key={row.id}>
                    <td>{describeInstrument(row)}</td>
                    <td className="is-numeric u-data">
                      <Amount value={row.latest?.price ?? null} places={4} />
                    </td>
                    <td className="u-data">{row.latest?.date ?? "never priced"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Keyed on the receipt, so a recorded price empties the boxes and a refusal keeps them. */}
          <Form
            method="post"
            className="panel-form"
            key={
              recorded === null
                ? "form"
                : `${recorded.instrumentId}-${recorded.date}-${recorded.price}`
            }
          >
            <input type="hidden" name="intent" value="manual-price" />
            <FormError message={refusal?.formError} />

            <div>
              <label htmlFor="manual-price-instrument">
                Instrument
                <select
                  id="manual-price-instrument"
                  name="instrumentId"
                  defaultValue={refusal?.values.instrumentId ?? ""}
                  aria-invalid={refusal?.errors.instrumentId ? true : undefined}
                >
                  <option value="">Choose…</option>
                  {manual.map((row) => (
                    <option key={row.id} value={row.id}>
                      {describeInstrument(row)}
                    </option>
                  ))}
                </select>
              </label>
              <FieldError message={refusal?.errors.instrumentId} />
            </div>

            <div>
              <label htmlFor="manual-price-price">Price per unit</label>
              <InterpretedNumberInput
                id="manual-price-price"
                name="price"
                defaultValue={refusal?.values.price ?? ""}
                // `text`, not `number` — a number input silently drops unparseable paste ("$1,052.41").
                type="text"
                inputMode="decimal"
                placeholder="52.4100"
                aria-describedby="manual-price-price-format"
                autoComplete="off"
                noteId="manual-price-price-format"
                onServerErrorActiveChange={setPriceErrorActive}
                rule={unitPriceRule("The price")}
                serverErrorId={refusal?.errors.price ? "manual-price-price-error" : undefined}
                shape="money"
              />
              {priceErrorActive ? (
                <FieldError id="manual-price-price-error" message={refusal?.errors.price} />
              ) : null}
            </div>

            <div>
              <label htmlFor="manual-price-as-of">
                Priced on
                <input
                  id="manual-price-as-of"
                  name="asOf"
                  type="date"
                  defaultValue={refusal?.values.asOf ?? today}
                  min={earliestAsOf}
                  max={latestAsOf}
                  aria-invalid={refusal?.errors.asOf ? true : undefined}
                />
              </label>
              <FieldError message={refusal?.errors.asOf} />
            </div>

            <button type="submit" className="button">
              Save price
            </button>
          </Form>
        </>
      )}
    </section>
  );
}

// Rendering, not a rule — vocabulary is the ledger's (`0010_price_backfill.sql`). Unknown outcome falls back to the stored value, not blank.
function attemptWords(gap: BackfillGap): React.ReactNode {
  if (!gap.willTry) {
    if (gap.priceSource === "manual") {
      return "Never fetched — priced by hand. Record a price dated on or before the held-from date above to cover it.";
    }
    if (gap.symbol === null) {
      return "Never — no ticker recorded, so there is nothing to fetch under.";
    }
    return "Never — this instrument is not priced from the feed.";
  }

  if (gap.lastAttempt === null) return "Not tried yet — the next refresh will.";

  // UTC, server-formatted (`settings/accounts.tsx`'s reason: no JS, no browser clock).
  const on = new Date(gap.lastAttempt.at).toISOString().slice(0, 10);
  const said = wordsFor(gap.lastAttempt.outcome);

  // Empty error is a valid row (provider failed with nothing to say) — appending it would leave a dangling colon.
  const because = gap.lastAttempt.error?.trim();

  return (
    <>
      <span className="u-data">{on}</span> — {because ? `${said} ${because}` : said}
    </>
  );
}

// Keyed by {@link BackfillOutcome}, not `string` — a forgotten literal fails the typecheck rather than shipping a blank cell.
const OUTCOME_WORDS: Record<BackfillOutcome, string> = {
  filled: "closes were written, and more are still missing.",
  nothing_to_write: "the feed answered, and every day it returned was already stored.",
  no_history: "the feed has no history for this ticker — it may be delisted or renamed.",
  non_usd: "the history is quoted in another currency, which this instance cannot hold.",
  split_unresolved: "a share split in the range could not be applied, so nothing was stored.",
  provider_failed: "the request failed:",
};

// Tolerates a stored value the map has never heard of, falling back to it — written as a search so no key assertion is needed.
function wordsFor(outcome: string): string {
  return Object.entries(OUTCOME_WORDS).find(([stored]) => stored === outcome)?.[1] ?? outcome;
}
