import { Form, redirect } from "react-router";

import { Amount } from "~/components/amount";
import { FieldError, FormError } from "~/components/error-message";
import { ASSET_CLASSES } from "~/lib/account-options";
import {
  NotFoundError,
  ValidationError,
  formFields,
  refused,
} from "~/lib/input.server";
import { describeInstrument } from "~/lib/format";
import {
  NEW_CLASSIFICATION,
  resolutionFieldsAt,
  resolutionScreen,
  resolveAll,
} from "~/lib/instrument-resolution.server";
import { socketProbe } from "~/lib/provider-socket.server";
import { sameRawStrings } from "~/lib/raw-string";
import { STALE_REVIEW_MESSAGE, parseDraft, requireDraft } from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { Route } from "./+types/instruments";

/**
 * Step three, four for a file of several accounts — resolve the file's first
 * sightings (ingest brief §5): misses against the alias table, pointed at an
 * existing instrument or created.
 * Both paths write the draft's answer; the commit promotes it to vocabulary,
 * so the next export passes silently only once this one is recorded.
 * Reached only with at least one miss.
 */
export function meta() {
  return [{ title: "New instruments · Upload · Portfolio" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);
    const staleReview = new URL(request.url).searchParams.get("stale") === "true";
    const stale = staleReview ? "?stale=true" : "";

    // `parseDraft` owns the resume rule — nothing unresolved skips by redirect, never an empty screen (brief §7.5).
    const result = await parseDraft(draft);
    if (result.step === "columns" || result.step === "accounts") {
      return redirect(`/upload/${draft.id}/${result.step}${stale}`);
    }
    if (result.step === null) return redirect(`/upload/${draft.id}/review${stale}`);

    const screen = await resolutionScreen(result.parsed.positions, draft.id);

    // A concurrent draft's submit resolving everything is the same skip as above.
    if (screen.unresolved.length === 0) return redirect(`/upload/${draft.id}/review${stale}`);

    return {
      steps: {
        current: result.accountsSkipped === null ? 3 : 4,
        draftId: draft.id,
        instrumentsSkipped: draft.hadFirstSightings === false,
        accountsSkipped: result.accountsSkipped,
      } satisfies UploadStepsData,
      screen,
      nameColumn: result.mapping.columns.name ?? null,
      newClassification: NEW_CLASSIFICATION,
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
    const draft = await requireDraft(params.draftId);
    const result = await parseDraft(draft);
    if (result.step === "columns" || result.step === "accounts") {
      return redirect(`/upload/${draft.id}/${result.step}${stale}`);
    }

    // A double submit finds everything already resolved and moves on, as the loader would.
    if (result.step === null) return redirect(`/upload/${draft.id}/review${stale}`);

    const { unresolved } = result;

    // Each posted group carries its raw string so a stale form can't land an
    // answer on the wrong one. `sameRawStrings`: browser rewrites CRLF in transit.
    if (unresolved.some((raw, index) => !sameRawStrings(values[`raw-${index}`] ?? "", raw))) {
      throw ValidationError.form(
        "The file's first sightings changed while this page was open — " +
          "check the answers below and save again.",
      );
    }

    // `raw` is the draft's own parsed string, never the posted copy — the alias stores the file's own bytes.
    await resolveAll(
      draft.id,
      unresolved.map((raw, index) => ({ raw, fields: resolutionFieldsAt(values, index) })),
      { probe: socketProbe },
    );

    return redirect(`/upload/${draft.id}/review${stale}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      return refused(error, values);
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Instruments({ loaderData, actionData }: Route.ComponentProps) {
  const { screen, nameColumn, newClassification, staleReviewMessage } = loaderData;

  const errors = actionData?.errors;
  // Typed wins over default on a refusal; `actionData` present means a refused submit.
  const values = actionData?.values;

  const invalid = (name: string): true | undefined =>
    errors?.[name] !== undefined ? true : undefined;

  return (
    <section className="panel">
      <div className="panel-body form-intro">
        <p>
          <span className="u-data">{screen.unresolved.length}</span> of{" "}
          <span className="u-data">{screen.totalPositions}</span>{" "}
          {screen.totalPositions === 1 ? "holding" : "holdings"} in this file{" "}
          {screen.unresolved.length === 1 ? "has" : "have"} not been seen before.
        </p>
        <p>
          An instrument created here exists at once. The answers themselves travel with this
          upload and become vocabulary when the statement is recorded at the last step, so an
          upload abandoned before then teaches the next one no names.
        </p>

        <FormError message={staleReviewMessage} />

        <FormError message={actionData?.formError} />
      </div>

      {/* No skip: a skipped string would go missing from the statement, and §5.2 reads a missing row as sold. */}
      <Form method="post">
        {screen.unresolved.map((item, index) => {
          const kind = values?.[`kind-${index}`];

          return (
            <div className="resolve-item" key={item.raw}>
              <input type="hidden" name={`raw-${index}`} value={item.raw} />

              {/* Byte-exact, as the file wrote it — prettifying would show something other than what the alias table stores. */}
              <h3 className="resolve-raw">{item.raw}</h3>
              <p className="cell-sub">
                {item.name !== null && nameColumn !== null ? (
                  <>
                    {nameColumn}: {item.name} ·{" "}
                  </>
                ) : null}
                <span className="u-data">
                  <Amount value={item.quantity} shape="quantity" />
                </span>{" "}
                units
              </p>

              <FieldError message={errors?.[`kind-${index}`]} />

              {/* Both branches always render — greying the unchosen one needs JavaScript; its fields are ignored on submit. */}
              <label className="choice">
                <input
                  type="radio"
                  name={`kind-${index}`}
                  value="existing"
                  defaultChecked={kind === "existing"}
                />
                This is an instrument already listed
              </label>

              <div className="panel-form">
                <div>
                  <label htmlFor={`instrumentId-${index}`}>
                    Instrument
                    <select
                      id={`instrumentId-${index}`}
                      name={`instrumentId-${index}`}
                      defaultValue={values?.[`instrumentId-${index}`] ?? ""}
                      aria-invalid={invalid(`instrumentId-${index}`)}
                    >
                      <option value="">Choose…</option>
                      {screen.instruments.map((instrument) => (
                        <option key={instrument.id} value={instrument.id}>
                          {describeInstrument(instrument)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <FieldError message={errors?.[`instrumentId-${index}`]} />
                </div>
              </div>

              <label className="choice">
                <input
                  type="radio"
                  name={`kind-${index}`}
                  value="create"
                  defaultChecked={kind === "create"}
                />
                This is new
              </label>

              <div className="panel-form">
                <div>
                  <label htmlFor={`symbol-${index}`}>
                    Symbol
                    <input
                      id={`symbol-${index}`}
                      name={`symbol-${index}`}
                      defaultValue={values?.[`symbol-${index}`] ?? ""}
                      aria-invalid={invalid(`symbol-${index}`)}
                      autoComplete="off"
                    />
                  </label>
                  <p className="field-note">Leave empty for an instrument with no public ticker.</p>
                  <FieldError message={errors?.[`symbol-${index}`]} />
                </div>

                <div>
                  <label htmlFor={`name-${index}`}>
                    Name
                    <input
                      id={`name-${index}`}
                      name={`name-${index}`}
                      // Prefilled from the mapped name column, or the raw string when none is mapped.
                      defaultValue={
                        values !== undefined
                          ? (values[`name-${index}`] ?? "")
                          : (item.name ?? item.raw)
                      }
                      aria-invalid={invalid(`name-${index}`)}
                      autoComplete="off"
                    />
                  </label>
                  <FieldError message={errors?.[`name-${index}`]} />
                </div>

                <fieldset>
                  <legend>Price source</legend>
                  <label className="choice">
                    <input
                      type="radio"
                      name={`priceSource-${index}`}
                      value="feed"
                      defaultChecked={values?.[`priceSource-${index}`] === "feed"}
                    />
                    Feed
                  </label>
                  <label className="choice">
                    <input
                      type="radio"
                      name={`priceSource-${index}`}
                      value="manual"
                      defaultChecked={values?.[`priceSource-${index}`] === "manual"}
                    />
                    Manual price
                  </label>
                  <p className="field-note">
                    A manual price is typed from the statement and carries forward until it is
                    changed.
                  </p>
                  <FieldError message={errors?.[`priceSource-${index}`]} />
                </fieldset>

                <div>
                  <label htmlFor={`classificationId-${index}`}>
                    Classification
                    <select
                      id={`classificationId-${index}`}
                      name={`classificationId-${index}`}
                      defaultValue={values?.[`classificationId-${index}`] ?? ""}
                      aria-invalid={invalid(`classificationId-${index}`)}
                    >
                      <option value="">Choose…</option>
                      {screen.classifications.map((classification) => (
                        <option key={classification.id} value={classification.id}>
                          {classification.name}
                        </option>
                      ))}
                      <option value={newClassification}>New classification…</option>
                    </select>
                  </label>
                  <FieldError message={errors?.[`classificationId-${index}`]} />
                </div>

                <div>
                  <label htmlFor={`newClassificationName-${index}`}>
                    New classification
                    <input
                      id={`newClassificationName-${index}`}
                      name={`newClassificationName-${index}`}
                      defaultValue={values?.[`newClassificationName-${index}`] ?? ""}
                      aria-invalid={invalid(`newClassificationName-${index}`)}
                      autoComplete="off"
                    />
                  </label>
                  <p className="field-note">Used only when "New classification…" is chosen.</p>
                  <FieldError message={errors?.[`newClassificationName-${index}`]} />
                </div>

                <div>
                  <label htmlFor={`newClassificationAssetClass-${index}`}>
                    Asset class
                    <select
                      id={`newClassificationAssetClass-${index}`}
                      name={`newClassificationAssetClass-${index}`}
                      defaultValue={values?.[`newClassificationAssetClass-${index}`] ?? ""}
                      aria-invalid={invalid(`newClassificationAssetClass-${index}`)}
                    >
                      <option value="">Choose…</option>
                      {ASSET_CLASSES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <FieldError message={errors?.[`newClassificationAssetClass-${index}`]} />
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
