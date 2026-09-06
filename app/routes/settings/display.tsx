import { Form, redirect } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { MASKING_POLICIES, clearedMaskingCookie } from "~/lib/masking";
import { readMaskingPolicy, saveMaskingPolicy } from "~/lib/settings.server";

import type { Route } from "./+types/display";

/**
 * Thin wrapper over `settings.server.ts` (spec 0007, ADR-0002). Not the
 * masking control — that's in the chrome; this sets what a browser opens
 * in. Named Display, not Masking, since §12's theme choice lands here too.
 */
export function meta() {
  return [{ title: "Display · Settings · Portfolio" }];
}

export async function loader() {
  return { maskingPolicy: await readMaskingPolicy() };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    await saveMaskingPolicy(values);

    // Cookie cleared, not rewritten (ADR-0002) — the resolver reads the
    // policy now, only for a browser with nothing left to say. Redirect, not
    // 204, so JavaScript-off still repaints with the new policy (post/redirect/get).
    return redirect("/settings/display", {
      headers: { "Set-Cookie": clearedMaskingCookie() },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;

      // No `Set-Cookie` on a refusal — nothing changed for the reader to see.
      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    throw error;
  }
}

export default function Display({ loaderData, actionData }: Route.ComponentProps) {
  const { maskingPolicy } = loaderData;
  const error = actionData?.errors.maskingPolicy;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Display</h1>
          <p className="page-subtitle">
            How the screens look before anyone touches them. Hiding the amounts on the screen
            in front of you is the control in the sidebar — this is what a browser starts in.
          </p>
        </div>
      </header>

      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">Amounts on a new browser</h2>
        </header>

        <Form method="post" className="panel-form">
          {actionData?.formError ? (
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          ) : null}

          {/* Radios, not a select — each option needs a sentence a select would hide. */}
          <fieldset>
            <legend>A browser opens</legend>

            {MASKING_POLICIES.map((policy) => (
              <label key={policy.value} className="choice">
                <input
                  type="radio"
                  name="maskingPolicy"
                  value={policy.value}
                  defaultChecked={
                    (actionData?.values.maskingPolicy ?? maskingPolicy) === policy.value
                  }
                  aria-invalid={error ? true : undefined}
                />
                {policy.label}
              </label>
            ))}

            <p className="field-note">
              A browser nobody has answered for opens masked, including one whose policy is{" "}
              <em>as last left</em> — clearing cookies puts a browser back to that. Masking
              hides the amounts from anyone reading over your shoulder. It is not the gate
              and it keeps nobody out: whoever can open a masked screen can unmask it.
            </p>

            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>

          <button type="submit" className="button">
            Save
          </button>
        </Form>
      </section>
    </>
  );
}
