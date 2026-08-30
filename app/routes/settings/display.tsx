import { Form, redirect } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { MASKING_POLICIES, clearedMaskingCookie } from "~/lib/masking";
import { readMaskingPolicy, saveMaskingPolicy } from "~/lib/settings.server";

import type { Route } from "./+types/display";

/**
 * Settings → Display (spec 0007, ADR-0002) — a thin wrapper over
 * `settings.server.ts`, as Tax is; what a policy may be lives there and in
 * `masking.ts`.
 *
 * **Not the masking control.** The control is in the chrome, and ADR-0002
 * records why it cannot move here: first run under the seeded policy is a
 * page of dots, and dots whose only cure is three clicks into Settings is a
 * broken app. This tab sets what a browser *opens* in; the chrome decides
 * what it shows now. Named Display, not Masking, because §12's theme choice
 * lands here too — one tab for "how the screens look".
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

    // The state cookie goes with the write — the whole reason this returns a
    // `Response` where Tax returns null (ADR-0002): without it the setting
    // appears to do nothing on the browser that changed it, and the lifetime
    // the *old* policy gave that cookie outlives the policy. Cleared, not
    // rewritten: the resolver answers "what does a browser open in" from the
    // policy, and only for a browser with nothing left to say.
    //
    // A REDIRECT, not a bare 204: a document POST answered 204 leaves the
    // browser on the page it submitted — story 25 exactly false with
    // JavaScript off. Post/redirect/get repaints in both browsers and re-runs
    // the shell's loader, which is what puts the new policy on screen.
    return redirect("/settings/display", {
      headers: { "Set-Cookie": clearedMaskingCookie() },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component: `FORM_ERROR` lives in a `.server`
      // module, and a component referencing it would drag the database into
      // the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;

      // No `Set-Cookie` on this path. Clearing it after a refused write would
      // change the reader's screen with no cause they could see.
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
          {/* Close to unreachable with one field — exactly why it must not
              be the refusal that goes unrendered: a form that did nothing
              and said nothing. */}
          {actionData?.formError ? (
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          ) : null}

          {/* Radios, not a select: three options that each need a sentence,
              and a select hides two of them behind a click at the moment of
              deciding. */}
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
