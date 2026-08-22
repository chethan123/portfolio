import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { rateDigits } from "~/lib/allocation";
import { readCapitalGainsRate, saveCapitalGainsRate } from "~/lib/settings.server";

import type { Route } from "./+types/tax";

/**
 * Settings → Tax.
 *
 * A thin wrapper over `settings.server.ts`, exactly as People and Accounts are
 * over theirs: it reads the form, hands the raw fields down, and renders what
 * comes back. What a rate is allowed to be lives in that module.
 *
 * One field, and it is here rather than in an environment variable because it
 * is the household's number rather than the deployment's — the argument is
 * written out in `0005_app_setting.sql` and in `settings.server.ts`.
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
      // Split here rather than in the component: `FORM_ERROR` lives in a
      // `.server` module, and a component referencing it would drag that module
      // — and the database with it — into the client bundle.
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
          {/* A refusal that names no field would otherwise be a form that did
              nothing and said nothing. There is one field here, so this is
              close to unreachable — which is exactly why it must not be the
              case that goes unrendered. */}
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
                // What was typed survives a refusal; otherwise the box shows
                // the stored rate with the column's padding taken off and
                // nothing rounded. Rounding here would round-trip: a rate saved
                // as 3.75 would come back as 3.8 and the next save would store
                // that, quietly changing a figure nobody edited.
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
