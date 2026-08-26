import { Form } from "react-router";

import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { MASKING_POLICIES, clearedMaskingCookie } from "~/lib/masking";
import { readMaskingPolicy, saveMaskingPolicy } from "~/lib/settings.server";

import type { Route } from "./+types/display";

/**
 * Settings → Display (spec 0007, ADR-0002).
 *
 * A thin wrapper over `settings.server.ts`, exactly as Tax is over its own: it
 * reads the form, hands the raw fields down, and renders what comes back. What
 * a policy is allowed to be lives in that module and in `masking.ts`.
 *
 * **What this tab is not.** It is not the masking control. The control is in
 * the chrome on every screen, and ADR-0002 records why it cannot move here: a
 * household's first run under the seeded policy is a page of dots, and a page
 * of dots whose only cure is three clicks into Settings is a broken app. This
 * tab sets what a browser *opens* in; the chrome decides what it is showing
 * now.
 *
 * **The tab is named Display rather than Masking** because §12's theme choice
 * lands here too when it is built. One tab for "how the screens look", rather
 * than a tab per preference.
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

    // The state cookie goes with the write, and this is the whole reason this
    // action returns a `Response` rather than null (ADR-0002). Without it the
    // setting appears to do nothing on the browser that changed it — the old
    // cookie still wins on every screen — and the lifetime the *old* policy
    // gave that cookie would outlive the policy itself.
    //
    // Cleared rather than rewritten to match the new policy: what a browser
    // opens in is a question the resolver answers from the policy, and it can
    // only answer it for a browser with nothing left to say.
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": clearedMaskingCookie() },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here rather than in the component: `FORM_ERROR` lives in a
      // `.server` module, and a component referencing it would drag that module
      // — and the database with it — into the client bundle.
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
          {/* A refusal that names no field would otherwise be a form that did
              nothing and said nothing. There is one field here, so this is
              close to unreachable — which is exactly why it must not be the
              case that goes unrendered. */}
          {actionData?.formError ? (
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          ) : null}

          {/* Radios rather than a select: three options, all of which need a
              sentence to be understood, and a select would hide two of them
              behind a click at the moment someone is deciding between them. */}
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
              hides the amounts from anyone reading over your shoulder. It is not a password
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
