import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { backfillGaps } from "~/lib/prices.server";
import { readRefreshCadence, saveRefreshCadence } from "~/lib/settings.server";

import type { BackfillGap, BackfillOutcome } from "~/lib/prices.server";
import type { Route } from "./+types/prices";

/**
 * Thin wrapper over `settings.server.ts`/`prices.server.ts` (cadence is a
 * row, not an env var — `0008_refresh_cadence.sql`). Second panel answers
 * "why is this still unpriced" (ADR-0011), listing every gap with a reason,
 * tried or not.
 */
export function meta() {
  return [{ title: "Prices · Settings · Portfolio" }];
}

export async function loader() {
  const [refreshCadenceMinutes, gaps] = await Promise.all([readRefreshCadence(), backfillGaps()]);

  return { refreshCadenceMinutes, gaps };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    await saveRefreshCadence(values);

    // No payload — the loader re-run shows the stored cadence as confirmation.
    return null;
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;

      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    throw error;
  }
}

export default function Prices({ loaderData, actionData }: Route.ComponentProps) {
  const { refreshCadenceMinutes, gaps } = loaderData;
  const error = actionData?.errors.refreshCadenceMinutes;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Prices</h1>
          <p className="page-subtitle">
            How often prices are fetched from the feed, and what the spine does not cover yet.
            Quotes are asked for only while the market is open; a refresh at any hour also fills
            in past closes for anything held further back than the price history reaches.
          </p>
        </div>
      </header>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Refresh cadence</h2>
        </header>

        <Form method="post" className="panel-form">
          {actionData?.formError ? (
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          ) : null}

          <div>
            <label htmlFor="refresh-cadence">
              Minutes between refreshes
              <input
                id="refresh-cadence"
                name="refreshCadenceMinutes"
                inputMode="numeric"
                defaultValue={
                  error
                    ? (actionData?.values.refreshCadenceMinutes ?? "")
                    : String(refreshCadenceMinutes)
                }
                aria-invalid={error ? true : undefined}
                aria-describedby="refresh-cadence-note"
                autoComplete="off"
              />
            </label>

            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}

            <p id="refresh-cadence-note" className="field-note">
              A whole number from 1 to 1440 — the default is 15. A lower number costs more
              requests against the feed during market hours. Outside them a refresh asks for no
              quotes, and spends a request only on the rows below that a feed can still fill — at
              most a handful per refresh, and none at all once there are none. A saved change is
              picked up when the next refresh runs, so it can take up to one old cadence to
              apply.
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

// Rendering, not a rule — vocabulary is the ledger's (`0010_price_backfill.sql`). Unknown outcome falls back to the stored value, not blank.
function attemptWords(gap: BackfillGap): React.ReactNode {
  if (!gap.willTry) {
    if (gap.priceSource === "manual") {
      return "Never — priced by hand, so there is no feed history to fetch.";
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
