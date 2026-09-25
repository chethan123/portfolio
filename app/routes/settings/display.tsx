import { useEffect, useRef } from "react";
import { Form, redirect, useRevalidator } from "react-router";

import { FieldError, FormError } from "~/components/error-message";
import { ValidationError, formFields, refused } from "~/lib/input.server";
import {
  MASKING_POLICIES,
  MASKING_ENHANCED_FIELD,
  adoptSavedMaskingPolicy,
  clearedMaskingCookie,
  browserMaskingIntentIsCurrent,
  captureBrowserMaskingIntent,
  newMaskingIntent,
} from "~/lib/masking";
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
  const enhanced = values[MASKING_ENHANCED_FIELD] === "1";
  const intent = values.maskingIntent;

  try {
    await saveMaskingPolicy(values);

    // A document POST has no script to reset this browser's state. An enhanced response carries
    // success back to the component, which clears only if no newer masking intent has won.
    if (!enhanced) {
      return redirect("/settings/display", {
        headers: { "Set-Cookie": clearedMaskingCookie() },
      });
    }

    // The component clears only after this success and only if no later masking intent won.
    return { saved: true as const, intent, errors: {}, formError: null, values };
  } catch (error) {
    if (error instanceof ValidationError) {
      // No `Set-Cookie` on a refusal — nothing changed for the reader to see.
      return { saved: false as const, ...refused(error, values) };
    }
    throw error;
  }
}

export default function Display({ loaderData, actionData }: Route.ComponentProps) {
  const { maskingPolicy } = loaderData;
  const error =
    actionData !== undefined && "maskingPolicy" in actionData.errors
      ? actionData.errors.maskingPolicy
      : undefined;
  const pending = useRef<{ request: string; masking: string | undefined } | null>(null);
  const revalidator = useRevalidator();

  useEffect(() => {
    if (actionData?.saved !== true) return;

    const submitted = pending.current;
    pending.current = null;
    if (
      submitted === null ||
      submitted.request !== actionData.intent ||
      !browserMaskingIntentIsCurrent(submitted.masking)
    ) {
      return;
    }

    const policy = MASKING_POLICIES.find(
      ({ value }) => value === actionData.values.maskingPolicy,
    )?.value;
    if (policy === undefined) return;

    void adoptSavedMaskingPolicy(policy, submitted.masking, () => revalidator.revalidate());
  }, [actionData, revalidator]);

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

        <Form
          method="post"
          className="panel-form"
          onSubmit={(event) => {
            const enhanced = event.currentTarget.elements.namedItem(MASKING_ENHANCED_FIELD);
            if (enhanced instanceof HTMLInputElement) enhanced.value = "1";
            const request = event.currentTarget.elements.namedItem("maskingIntent");
            const requestId = newMaskingIntent();
            if (request instanceof HTMLInputElement) request.value = requestId;
            pending.current = { request: requestId, masking: captureBrowserMaskingIntent() };
          }}
        >
          <input type="hidden" name={MASKING_ENHANCED_FIELD} defaultValue="" />
          <input type="hidden" name="maskingIntent" defaultValue="" />
          <FormError message={actionData?.formError} />

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

            <FieldError message={error} />
          </fieldset>

          <button type="submit" className="button">
            Save
          </button>
        </Form>
      </section>
    </>
  );
}
