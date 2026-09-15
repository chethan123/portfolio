import { Form, Link } from "react-router";

import { AccountNumberTail } from "~/components/account-number-tail";
import { Amount } from "~/components/amount";
import { describeInstrument } from "~/lib/format";
import { FORM_ERROR, ValidationError, formFields } from "~/lib/input.server";
import { changeAlias, listAliases } from "~/lib/instrument-aliases.server";
import { sameRawStrings } from "~/lib/raw-string";

import type { AliasChangePreview } from "~/lib/instrument-aliases.server";
import type { Route } from "./+types/instruments";

// The alias half of the Instruments tab (DESIGN.md §8.4): every name an upload has taught this
// instance, and a guarded repoint/forget. Thin wrapper — every rule lives in
// `instrument-aliases.server.ts`.
export function meta() {
  return [{ title: "Instruments · Settings · Portfolio" }];
}

export async function loader() {
  return listAliases();
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const outcome = await changeAlias(values);

    if (!outcome.applied) {
      return { preview: outcome.preview, applied: null, errors: null, formError: null, values };
    }

    return {
      preview: null,
      applied: { intent: outcome.intent, rawString: outcome.rawString, to: outcome.to },
      errors: null,
      formError: null,
      values,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return {
        preview: null,
        applied: null,
        errors: fieldErrors,
        formError: formError ?? null,
        values,
      };
    }
    throw error;
  }
}

function Preview({ preview }: { preview: AliasChangePreview }) {
  const from = describeInstrument(preview.from);
  const heading =
    preview.to === null
      ? `Forget "${preview.rawString}"?`
      : `Repoint "${preview.rawString}" to ${describeInstrument(preview.to)}?`;

  return (
    <section className="panel" aria-labelledby="alias-preview-title">
      <header className="panel-header">
        <h2 className="panel-title" id="alias-preview-title">
          {heading}
        </h2>
      </header>

      <div className="panel-body form-intro">
        <p>
          {preview.to === null ? (
            <>
              The next upload naming "{preview.rawString}" will ask what it means instead of
              reading it as {from}.
            </>
          ) : (
            <>
              The next upload naming "{preview.rawString}" will read it as{" "}
              {describeInstrument(preview.to)} instead of {from}.
            </>
          )}
        </p>

        {preview.heldNow.length === 0 ? (
          <p>No open account holds {from} today. Nothing recorded changes either way.</p>
        ) : (
          <>
            <p>
              What is already recorded stays as it is. {from} is held today in{" "}
              <span className="u-data">{preview.heldNow.length}</span>{" "}
              {preview.heldNow.length === 1 ? "account" : "accounts"}; if any of those figures
              came from this name, upload that account's statement again to re-record it.
            </p>
            <ul className="record-list">
              {preview.heldNow.map((holding) => (
                <li key={holding.accountId}>
                  <Link to={`/accounts/${holding.accountId}`}>
                    {holding.accountName}
                    <AccountNumberTail tail={holding.accountNumberTail} />
                  </Link>{" "}
                  — owned by {holding.ownerName} ·{" "}
                  <span className="u-data">
                    <Amount value={holding.quantity} shape="quantity" />
                  </span>{" "}
                  units
                </li>
              ))}
            </ul>
          </>
        )}

        {preview.statements.length === 0 ? (
          <p>No recorded statement file names "{preview.rawString}".</p>
        ) : (
          <>
            <p>
              <span className="u-data">{preview.statements.length}</span> recorded{" "}
              {preview.statements.length === 1 ? "statement names" : "statements name"} "
              {preview.rawString}":
            </p>
            <ul className="record-list">
              {preview.statements.map((statement) => (
                <li key={statement.setId}>
                  <Link to={`/accounts/${statement.accountId}`}>{statement.accountName}</Link>
                  {" · "}
                  <span className="u-data">{statement.asOf}</span>
                  {statement.filename !== null ? ` · ${statement.filename}` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Form method="post" className="panel-form">
        <input type="hidden" name="rawString" value={preview.rawString} />
        <input type="hidden" name="fromInstrumentId" value={preview.from.id} />
        {preview.to !== null ? (
          <input type="hidden" name="instrumentId" value={preview.to.id} />
        ) : null}
        <input type="hidden" name="confirm" value="true" />
        <div className="record-actions">
          <button
            type="submit"
            name="intent"
            value={preview.intent}
            className={preview.to === null ? "button button--danger" : "button"}
          >
            {preview.to === null ? "Forget it" : "Repoint it"}
          </button>
          <Link to="/settings/instruments" className="button button--quiet">
            Keep it as it is
          </Link>
        </div>
      </Form>
    </section>
  );
}

export default function Instruments({ loaderData, actionData }: Route.ComponentProps) {
  const { aliases, instruments } = loaderData;

  // Line endings aside, as the domain matched the posted copy — else a multi-line name's
  // refusal lands beside no row; the drawn target tells two such spellings apart.
  const errorsFor = (alias: { rawString: string; instrument: { id: string } }) =>
    actionData?.errors &&
    sameRawStrings(actionData.values.rawString ?? "", alias.rawString) &&
    actionData.values.fromInstrumentId === alias.instrument.id
      ? actionData.errors
      : undefined;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Instruments</h1>
          <p className="page-subtitle">
            Every name an upload has taught this instance, exactly as the file wrote it, and the
            instrument it means. The next upload reads these before asking anything.
          </p>
        </div>
      </header>

      {actionData?.formError ? (
        <p className="form-error" role="alert">
          {actionData.formError}
        </p>
      ) : null}

      {actionData?.applied ? (
        <p className="form-note" role="status">
          {actionData.applied.to === null
            ? `"${actionData.applied.rawString}" is forgotten. ` +
              "The next upload naming it will ask what it means."
            : `"${actionData.applied.rawString}" now means ` +
              `${describeInstrument(actionData.applied.to)}.`}
        </p>
      ) : null}

      {actionData?.preview ? <Preview preview={actionData.preview} /> : null}

      {aliases.length === 0 ? (
        <p className="empty-note">
          No names are recorded yet. An upload's first sightings are written here when its
          statement is recorded.
        </p>
      ) : (
        <section className="panel">
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name in the file</th>
                  <th scope="col">Means</th>
                  <th scope="col">Instrument held in</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {aliases.map((alias, index) => {
                  const errors = errorsFor(alias);
                  // By position, not by name: a raw string is any bytes, an id attribute is not.
                  const selectId = `alias-target-${index}`;

                  return (
                    <tr key={alias.rawString}>
                      {/* Byte-exact, as the file wrote it — what is stored, not a prettier copy. */}
                      <th scope="row" className="resolve-raw">
                        {alias.rawString}
                      </th>
                      <td>{describeInstrument(alias.instrument)}</td>
                      <td>
                        {alias.heldIn === 0 ? (
                          "not held"
                        ) : (
                          <>
                            <span className="u-data">{alias.heldIn}</span>{" "}
                            {alias.heldIn === 1 ? "account" : "accounts"}
                          </>
                        )}
                      </td>
                      <td>
                        <Form method="post" className="record-form">
                          <input type="hidden" name="rawString" value={alias.rawString} />
                          <input
                            type="hidden"
                            name="fromInstrumentId"
                            value={alias.instrument.id}
                          />
                          <div>
                            <label className="visually-hidden" htmlFor={selectId}>
                              What "{alias.rawString}" should mean
                            </label>
                            <select
                              id={selectId}
                              name="instrumentId"
                              defaultValue={
                                errors
                                  ? (actionData?.values.instrumentId ?? "")
                                  : alias.instrument.id
                              }
                              aria-invalid={errors?.instrumentId ? true : undefined}
                            >
                              {instruments.map((instrument) => (
                                <option key={instrument.id} value={instrument.id}>
                                  {describeInstrument(instrument)}
                                </option>
                              ))}
                            </select>
                            {errors?.instrumentId ? (
                              <p className="field-error" role="alert">
                                {errors.instrumentId}
                              </p>
                            ) : null}
                          </div>
                          <div className="record-actions">
                            <button
                              type="submit"
                              name="intent"
                              value="repoint"
                              className="button button--quiet"
                            >
                              Repoint
                            </button>
                            <button
                              type="submit"
                              name="intent"
                              value="forget"
                              className="button button--danger"
                              aria-label={`Forget "${alias.rawString}"`}
                            >
                              Forget
                            </button>
                          </div>
                        </Form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
