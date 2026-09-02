import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { backfillGaps } from "~/lib/prices.server";
import { readRefreshCadence, saveRefreshCadence } from "~/lib/settings.server";

import type { BackfillGap, BackfillOutcome } from "~/lib/prices.server";
import type { Route } from "./+types/prices";

/**
 * Settings → Prices — a thin wrapper over `settings.server.ts` and
 * `prices.server.ts`, as Tax and Display are over theirs: read the form, hand
 * raw fields down, render what comes back. What a cadence may be lives in that
 * module; a row rather than an environment variable because the person wanting
 * prices fresher — or spend lower — is the one reading the screen
 * (`0008_refresh_cadence.sql`).
 *
 * The second panel is the household's answer to "why is this still unpriced in
 * March" and the operator's list of tickers to check against a statement
 * (ADR-0011). It lists instruments the backfill will never try as well as the
 * ones it will, with the reason, because their gaps are just as real and
 * Settings → Instruments is the answer for those.
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

    // No payload: the loader re-runs after an action, so the box showing the
    // stored cadence is the confirmation.
    return null;
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component: `FORM_ERROR` lives in a `.server`
      // module, and a component referencing it would drag the database into
      // the client bundle.
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
          {/* Close to unreachable with one field — exactly why it must not
              be the refusal that goes unrendered: a form that did nothing
              and said nothing. */}
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
                // What was typed survives a refusal; otherwise the box shows
                // the stored cadence.
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

            {/* The price tag, at the dial (ADR-0006, story 17): every
                distinct price is kept forever, so the cadence is a storage
                decision as much as a request-rate one — the figure belongs
                where the choice is made. */}
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

/**
 * What the last attempt on a row amounts to, in words.
 *
 * Rendering, not a rule: the vocabulary is the ledger's (`0010_price_backfill.sql`),
 * and this is the only place it is turned into a sentence. An outcome with no
 * sentence here falls back to the stored value rather than to nothing, so a
 * literal added to the schema and not to this map is legible rather than blank.
 */
function attemptWords(gap: BackfillGap): React.ReactNode {
  // Why, not just that: a hand-priced trust and a feed instrument nobody has
  // given a ticker are two different things for a person to do about. Each
  // branch reads a fact on the row rather than re-deriving the domain's rule for
  // `willTry`, so a fourth price source would fall to the last sentence rather
  // than be told its ticker is missing.
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

  // The UTC day, formatted on the server for `settings/accounts.tsx`'s reason:
  // these pages must work with JavaScript off, so there is no browser clock to
  // ask at render time and a locale-formatted date would disagree with itself
  // between the server render and hydration.
  const on = new Date(gap.lastAttempt.at).toISOString().slice(0, 10);
  const said = wordsFor(gap.lastAttempt.outcome);

  // An empty error is a row the ledger allows — a provider that failed with
  // nothing to say — and appending it would leave a dangling colon.
  const because = gap.lastAttempt.error?.trim();

  return (
    <>
      <span className="u-data">{on}</span> — {because ? `${said} ${because}` : said}
    </>
  );
}

/**
 * The ledger's closed vocabulary, as a person reads it.
 *
 * Keyed by {@link BackfillOutcome} rather than by `string`, which is what makes
 * this the *checked* copy: a literal added to `BACKFILL_OUTCOMES` and forgotten
 * here fails the typecheck, where a `Record<string, string>` would ship a blank
 * cell. The migration's `check` constraint and the const object are kept in step
 * by hand; this is the one of the three the compiler can hold.
 */
const OUTCOME_WORDS: Record<BackfillOutcome, string> = {
  filled: "closes were written, and more are still missing.",
  nothing_to_write: "the feed answered, and every day it returned was already stored.",
  no_history: "the feed has no history for this ticker — it may be delisted or renamed.",
  non_usd: "the history is quoted in another currency, which this instance cannot hold.",
  split_unresolved: "a share split in the range could not be applied, so nothing was stored.",
  provider_failed: "the request failed:",
};

/**
 * The sentence for one stored outcome, or the stored value itself.
 *
 * The value crosses the driver as a `string`, so the lookup has to tolerate one
 * the map has never heard of — which the `check` constraint makes impossible
 * and a person reading a blank cell could not diagnose. Written as a search
 * rather than an index so no assertion is needed to narrow the key.
 */
function wordsFor(outcome: string): string {
  return Object.entries(OUTCOME_WORDS).find(([stored]) => stored === outcome)?.[1] ?? outcome;
}
