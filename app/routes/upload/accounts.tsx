import { Form, Link, redirect } from "react-router";

import { FORM_ERROR, NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import {
  SKIP_NUMBER,
  STALE_REVIEW_MESSAGE,
  accountsScreen,
  answerAccountNumbers,
  requireDraft,
} from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { Route } from "./+types/accounts";

/**
 * Step three of a file of several accounts (spec 0023 decision 2, ADR-0015):
 * each account number no account records is given to an open account that
 * records none, or its rows are skipped. Asked, never guessed. The answers
 * stay the draft's until the commit writes each number onto its account.
 * Reached only with such a number.
 */
export function meta() {
  return [{ title: "Accounts · Upload · Portfolio" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);
    const staleReview = new URL(request.url).searchParams.get("stale") === "true";
    const stale = staleReview ? "?stale=true" : "";

    // Columns owed, one account, or every number matched: nothing to ask, never an empty screen.
    const screen = await accountsScreen(draft);
    if (screen.questions.length === 0) {
      return redirect(`/upload/${draft.id}/${screen.step ?? "review"}${stale}`);
    }

    return {
      steps: {
        current: 3,
        draftId: draft.id,
        instrumentsSkipped: draft.hadFirstSightings === false,
        accountsSkipped: false,
      } satisfies UploadStepsData,
      filename: draft.filename,
      screen,
      // Component can't import a `.server` module — the sentinel rides down with the data.
      skip: SKIP_NUMBER,
      staleReviewMessage: staleReview ? STALE_REVIEW_MESSAGE : null,
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());
  const stale = new URL(request.url).searchParams.get("stale") === "true" ? "?stale=true" : "";

  try {
    const { nextStep } = await answerAccountNumbers(params.draftId, values);
    return redirect(`/upload/${params.draftId}/${nextStep}${stale}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Accounts({ loaderData, actionData }: Route.ComponentProps) {
  const { filename, screen, skip, staleReviewMessage } = loaderData;
  const { questions, choices } = screen;

  const errors = actionData?.errors;
  // Posted wins over the draft's answers on a refusal, for the number it was posted with: a stale
  // form holds another number's choice at this index.
  const values = actionData?.values;
  const posted = (index: number, number: string) =>
    values?.[`number-${index}`] === number ? values[`accountId-${index}`] : undefined;

  return (
    <section className="panel">
      <div className="panel-body form-intro">
        <p>
          <strong>{filename}</strong> · several accounts
        </p>
        <p>
          <span className="u-data">{questions.length}</span>{" "}
          {questions.length === 1
            ? "account number in this file is recorded on no open account."
            : "account numbers in this file are recorded on no open account."}{" "}
          Give each to the account it belongs to, or skip its rows, which this upload then leaves
          out. Only an account with no number yet is offered; it keeps the number once this upload
          is recorded.
        </p>
        {choices.length === 0 ? (
          <p>
            Every open account records a number already, so these rows can only be skipped here —
            or the number recorded on its account under{" "}
            <Link to="/settings/accounts">Settings → Accounts</Link> first.
          </p>
        ) : null}

        {staleReviewMessage ? (
          <p className="form-error" role="alert">
            {staleReviewMessage}
          </p>
        ) : null}

        {actionData?.formError ? (
          <p className="form-error" role="alert">
            {actionData.formError}
          </p>
        ) : null}
      </div>

      <Form method="post">
        {questions.map((question, index) => {
          const field = `accountId-${index}`;
          const shown = question.instruments.slice(0, 4).join(", ");

          return (
            <div className="resolve-item" key={question.number}>
              <input type="hidden" name={`number-${index}`} value={question.number} />

              {/* As the file wrote it, trimmed: matching is exact (decision 15). */}
              <h3 className="resolve-raw">{question.number}</h3>
              <p className="cell-sub">
                <span className="u-data">{question.lines}</span>{" "}
                {question.lines === 1 ? "line" : "lines"} · {shown}
                {question.instruments.length > 4 ? ", …" : ""}
              </p>

              {question.stale !== null ? (
                <p className="field-error" role="alert">
                  {question.stale}
                </p>
              ) : null}

              <div className="panel-form">
                <div>
                  <label htmlFor={field}>
                    Account
                    <select
                      id={field}
                      name={field}
                      defaultValue={posted(index, question.number) ?? question.answer}
                      aria-invalid={errors?.[field] !== undefined ? true : undefined}
                    >
                      <option value="">Choose…</option>
                      {choices.map((group) => (
                        <optgroup key={group.ownerId} label={`Owned by ${group.ownerName}`}>
                          {group.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      <option value={skip}>Skip these rows</option>
                    </select>
                  </label>
                  {errors?.[field] ? (
                    <p className="field-error" role="alert">
                      {errors[field]}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}

        <div className="panel-form">
          <button type="submit" className="button">
            Save and continue
          </button>
        </div>
      </Form>
    </section>
  );
}
