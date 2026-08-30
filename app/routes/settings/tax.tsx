import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { rateDigits } from "~/lib/allocation";
import { readCapitalGainsRate, saveCapitalGainsRate } from "~/lib/settings.server";

import type { Route } from "./+types/tax";

/**
 * Settings → Tax — a thin wrapper over `settings.server.ts`, as People and
 * Accounts are over theirs: read the form, hand raw fields down, render what
 * comes back. What a rate may be lives in that module; why it is a row and
 * not an environment variable is `0005_app_setting.sql`.
 */
export function meta() {
  return [{ title: "Tax · Settings · Portfolio" }];
}

export async function loader() {
  return { capitalGainsRate: await readCapitalGainsRate() };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    await saveCapitalGainsRate(values);

    // No payload: the loader re-runs after an action, so the box showing the
    // stored rate is the confirmation.
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

export default function Tax({ loaderData, actionData }: Route.ComponentProps) {
  const { capitalGainsRate } = loaderData;
  const error = actionData?.errors.capitalGainsRate;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Tax</h1>
          <p className="page-subtitle">
            The rate the Analysis screen applies to an unrealized gain held in a taxable
            account. Nothing else on any screen uses it, and no figure anywhere is filed with
            it — this is an estimate of what settling a position would cost, not tax advice.
          </p>
        </div>
      </header>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Capital gains rate</h2>
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
            <label htmlFor="capital-gains-rate">
              Rate, as a percentage
              <input
                id="capital-gains-rate"
                name="capitalGainsRate"
                inputMode="decimal"
                // What was typed survives a refusal; otherwise the stored
                // rate, padding off, nothing rounded — rounding would
                // round-trip: 3.75 shown as 3.8, and the next save quietly
                // stores a figure nobody edited.
                defaultValue={
                  error
                    ? (actionData?.values.capitalGainsRate ?? "")
                    : rateDigits(capitalGainsRate)
                }
                aria-invalid={error ? true : undefined}
                aria-describedby="capital-gains-rate-note"
                autoComplete="off"
              />
            </label>

            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}

            <p id="capital-gains-rate-note" className="field-note">
              The default, 23.8%, is the 20% long-term capital gains rate plus the 3.8% net
              investment income tax. A household in a lower bracket, or in a state that taxes
              gains of its own, has a different number.
            </p>
          </div>

          <button type="submit" className="button">
            Save rate
          </button>
        </Form>
      </section>
    </>
  );
}
