import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { readRefreshCadence, saveRefreshCadence } from "~/lib/settings.server";

import type { Route } from "./+types/prices";

/**
 * Settings → Prices — a thin wrapper over `settings.server.ts`, as Tax and
 * Display are: read the form, hand raw fields down, render what comes back.
 * What a cadence may be lives in that module; a row rather than an
 * environment variable because the person wanting prices fresher — or spend
 * lower — is the one reading the screen (`0008_refresh_cadence.sql`).
 */
export function meta() {
  return [{ title: "Prices · Settings · Portfolio" }];
}

export async function loader() {
  return { refreshCadenceMinutes: await readRefreshCadence() };
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
  const { refreshCadenceMinutes } = loaderData;
  const error = actionData?.errors.refreshCadenceMinutes;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Prices</h1>
          <p className="page-subtitle">
            How often quotes are fetched from the price feed. The refresh runs only while the
            market is open — nights, weekends and market holidays cost nothing whatever the
            cadence says.
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
              requests against the feed during market hours and nothing outside them. A saved
              change is picked up when the next refresh runs, so it can take up to one old
              cadence to apply.
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
    </>
  );
}
