import { Form, redirect } from "react-router";

import {
  FORM_ERROR,
  NotFoundError,
  ValidationError,
  formFields,
} from "~/lib/input.server";
import {
  NEW_CLASSIFICATION,
  resolutionFieldsAt,
  resolutionScreen,
  resolveAll,
  sameRawStrings,
} from "~/lib/instrument-resolution.server";
import { formatQuantity } from "~/lib/holdings-view";
import { parseDraft, requireDraft } from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { Route } from "./+types/instruments";

/**
 * Step three — resolve the file's first sightings (ingest brief §5).
 *
 * Every distinct string in the instrument column was looked up byte-exact
 * against the alias table; the misses land here, each resolved once and
 * remembered forever — either pointed at an instrument that already exists
 * or created on the spot, and both paths write the alias, so the same
 * brokerage's next export passes through silently.
 *
 * This is the flow's one early write: resolving records vocabulary, not the
 * statement, which still waits for the review step. Reached only when there
 * is at least one miss — otherwise the loader redirects straight to review
 * and the step dims in the strip.
 */
export function meta() {
  return [{ title: "New instruments · Upload · Portfolio" }];
}

/** The four asset classes, in the brief's order, with their stored values. */
const ASSET_CLASS_OPTIONS = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bonds" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);

    // `parseDraft` owns the resume rule: a mapping that no longer parses
    // clean bounces to columns — a resolution screen cannot ask questions a
    // mapping has not raised — and a file with nothing unresolved is skipped
    // by redirect, never an empty screen: a step with nothing to do would
    // charge a click for no decision (brief §7.5).
    const result = await parseDraft(draft);
    if (result.step === "columns") return redirect(`/upload/${draft.id}/columns`);
    if (result.step === null) return redirect(`/upload/${draft.id}/review`);

    const screen = await resolutionScreen(result.parsed.positions);

    // Everything resolved between the two reads — a concurrent draft's
    // submit — is the same skip the redirect above performs.
    if (screen.unresolved.length === 0) return redirect(`/upload/${draft.id}/review`);

    return {
      steps: {
        current: 3,
        draftId: draft.id,
        instrumentsSkipped: draft.hadFirstSightings === false,
      } satisfies UploadStepsData,
      screen,
      // The caption the context line names the file's own name column by —
      // "Description: Vanguard Total International Stock ETF" — when one is
      // mapped.
      nameColumn: result.mapping.columns.name ?? null,
      // The sentinel rides down with the data, because the route's component
      // cannot import a `.server` module (the columns screen's precedent).
      newClassification: NEW_CLASSIFICATION,
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const draft = await requireDraft(params.draftId);
    const result = await parseDraft(draft);
    if (result.step === "columns") return redirect(`/upload/${draft.id}/columns`);

    // A double submit — two tabs, the back button — finds everything already
    // resolved and simply moves on, exactly as the loader would have.
    if (result.step === null) return redirect(`/upload/${draft.id}/review`);

    const { unresolved } = result;

    // The posted answers pair with the current unresolved strings by index,
    // and each group carries its raw string in a hidden field so a stale
    // form — another draft resolved one of these strings while this page sat
    // open — cannot land an answer on the wrong string. Compared through
    // `sameRawStrings`, because the browser rewrites a multi-line cell's
    // line endings to CRLF on the way through the hidden field.
    if (unresolved.some((raw, index) => !sameRawStrings(values[`raw-${index}`] ?? "", raw))) {
      throw ValidationError.form(
        "The file's first sightings changed while this page was open — " +
          "check the answers below and save again.",
      );
    }

    // `raw` is the draft's own parsed string, never the posted hidden-field
    // copy — the alias must store the bytes the file wrote, and the copy may
    // have been CRLF-mangled by the form round trip.
    await resolveAll(
      unresolved.map((raw, index) => ({ raw, fields: resolutionFieldsAt(values, index) })),
    );

    return redirect(`/upload/${draft.id}/review`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component: `FORM_ERROR` lives in a `.server`
      // module the client bundle must not drag in.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Instruments({ loaderData, actionData }: Route.ComponentProps) {
  const { screen, nameColumn, newClassification } = loaderData;

  const errors = actionData?.errors;
  // What was typed wins over every default on a refusal — a refusal must
  // never cost an edit. `actionData` present means re-rendering a refused
  // submit, so the defaults step aside entirely.
  const values = actionData?.values;

  const fieldError = (name: string) =>
    errors?.[name] ? (
      <p className="field-error" role="alert">
        {errors[name]}
      </p>
    ) : null;

  const invalid = (name: string): true | undefined =>
    errors?.[name] !== undefined ? true : undefined;

  return (
    <section className="panel">
      <div className="panel-body form-intro">
        {/* The count, stated plainly, then the one sentence of consequence:
            this step is the flow's one early write. */}
        <p>
          <span className="u-data">{screen.unresolved.length}</span> of{" "}
          <span className="u-data">{screen.totalPositions}</span>{" "}
          {screen.totalPositions === 1 ? "holding" : "holdings"} in this file{" "}
          {screen.unresolved.length === 1 ? "has" : "have"} not been seen before.
        </p>
        <p>
          Resolving writes the name down as vocabulary — the statement itself is still not
          recorded until the last step.
        </p>

        {actionData?.formError ? (
          <p className="form-error" role="alert">
            {actionData.formError}
          </p>
        ) : null}
      </div>

      {/* One form, one submit, no skip: a skipped string would be a holding
          silently missing from the statement, and §5.2's "a missing row means
          sold" turns that silence into a sale. */}
      <Form method="post">
        {screen.unresolved.map((item, index) => {
          const kind = values?.[`kind-${index}`];

          return (
            <div className="resolve-item" key={item.raw}>
              {/* The raw string rides back with the answers, pairing them to
                  this string however the unresolved list moves underneath. */}
              <input type="hidden" name={`raw-${index}`} value={item.raw} />

              {/* Exactly as the file wrote it — the byte-exact string is the
                  thing being resolved, and prettifying it would show something
                  other than what the alias table will store. */}
              <h3 className="resolve-raw">{item.raw}</h3>
              <p className="cell-sub">
                {item.name !== null && nameColumn !== null ? (
                  <>
                    {nameColumn}: {item.name} ·{" "}
                  </>
                ) : null}
                <span className="u-data">{formatQuantity(item.quantity)}</span> units
              </p>

              {fieldError(`kind-${index}`)}

              {/* Both branches always render their controls: greying the
                  unchosen one needs JavaScript, and a reader deciding between
                  the two needs to see what each asks. Fields in the unchosen
                  branch are simply ignored on submit. */}
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
                          {instrument.symbol !== null
                            ? `${instrument.symbol} — ${instrument.name}`
                            : instrument.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {fieldError(`instrumentId-${index}`)}
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
                  {fieldError(`symbol-${index}`)}
                </div>

                <div>
                  <label htmlFor={`name-${index}`}>
                    Name
                    <input
                      id={`name-${index}`}
                      name={`name-${index}`}
                      // Prefilled because the statement usually already says
                      // it: the mapped name column's value, or the raw string
                      // when no name column is mapped.
                      defaultValue={
                        values !== undefined
                          ? (values[`name-${index}`] ?? "")
                          : (item.name ?? item.raw)
                      }
                      aria-invalid={invalid(`name-${index}`)}
                      autoComplete="off"
                    />
                  </label>
                  {fieldError(`name-${index}`)}
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
                  {fieldError(`priceSource-${index}`)}
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
                  {fieldError(`classificationId-${index}`)}
                </div>

                {/* Always rendered, like every conditionally relevant control
                    in this flow: a reveal needs JavaScript, and the note costs
                    one line. */}
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
                  {fieldError(`newClassificationName-${index}`)}
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
                      {ASSET_CLASS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {fieldError(`newClassificationAssetClass-${index}`)}
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
