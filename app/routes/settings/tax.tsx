import { useState } from "react";
import { Form } from "react-router";

import { FieldError, FormError } from "~/components/error-message";
import { InterpretedNumberInput } from "~/components/interpreted-number-input";
import { percentRateRule } from "~/lib/decimal-input";
import { rateDigits } from "~/lib/format";
import { ValidationError, formFields, refused } from "~/lib/input.server";
import { readCapitalGainsRate, saveCapitalGainsRate } from "~/lib/settings.server";

import type { Route } from "./+types/tax";

// Thin wrapper over `settings.server.ts` — a row, not an env var (`0005_app_setting.sql`).
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

    // No payload — the loader re-run shows the stored rate as confirmation.
    return null;
  } catch (error) {
    if (error instanceof ValidationError) {
      return refused(error, values);
    }
    throw error;
  }
}

export default function Tax({ loaderData, actionData }: Route.ComponentProps) {
  const { capitalGainsRate } = loaderData;
  const error = actionData?.errors.capitalGainsRate;
  const [errorActive, setErrorActive] = useState(error !== undefined);

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
          <FormError message={actionData?.formError} />

          <div>
            <label htmlFor="capital-gains-rate">Rate, as a percentage</label>
            <InterpretedNumberInput
              id="capital-gains-rate"
              name="capitalGainsRate"
              inputMode="decimal"
              // Nothing rounded — rounding would round-trip: 3.75 shown as 3.8, then quietly saved as that.
              defaultValue={
                error ? (actionData?.values.capitalGainsRate ?? "") : rateDigits(capitalGainsRate)
              }
              aria-describedby="capital-gains-rate-format capital-gains-rate-note"
              autoComplete="off"
              noteId="capital-gains-rate-format"
              onServerErrorActiveChange={setErrorActive}
              rule={percentRateRule("A capital gains rate")}
              serverErrorId={error ? "capital-gains-rate-error" : undefined}
              shape="percentage"
            />

            {errorActive ? <FieldError id="capital-gains-rate-error" message={error} /> : null}

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
