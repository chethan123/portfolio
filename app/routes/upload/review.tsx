import { Form, Link, data, redirect } from "react-router";

import { Amount } from "~/components/amount";
import {
  FORM_ERROR,
  NotFoundError,
  ValidationError,
  earliestRecordableDate,
  formFields,
  latestRecordableDate,
} from "~/lib/input.server";
import { requestRefresh } from "~/lib/price-poller.server";
import { DraftNotReadyError, commitUpload, diffForDraft } from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { DiffAdded, DiffRemoved, DiffUpdated } from "~/lib/uploads.server";
import type { Route } from "./+types/review";

/**
 * Step four — the diff, then the commit (ingest brief §6): the safety
 * valve, and the flow's only write. §5.2's "a missing row means sold" makes
 * a filtered export dangerous — a file showing 2 of 30 positions is a
 * *valid* statement that silently sells 28 — so every removal is listed in
 * full, and a file removing more than half cannot commit without ticking a
 * sentence that says so. Review is read-only plus the date and the tick: a
 * wrong figure is fixed by walking back to columns, because it is wrong in
 * the mapping, not the diff.
 */
export function meta() {
  return [{ title: "Review · Upload · Portfolio" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const diff = await diffForDraft(params.draftId);

    return {
      steps: {
        current: 4,
        draftId: diff.draftId,
        // The columns step wrote down whether this file raised any first
        // sighting — the one moment the answer existed: an alias, once
        // written, does not say which draft wrote it. The strip dims entry 3
        // off this bit (brief §2.1, §7.5).
        instrumentsSkipped: diff.instrumentsSkipped,
      } satisfies UploadStepsData,
      diff,
      // Today in UTC, from the server, so the box does not open on a date the
      // reader's clock invented and the app then refuses (§4.1).
      today: new Date().toISOString().slice(0, 10),
      // The date control's two boundaries, read from the validator rather
      // than guessed, so the picker and the refusal state one rule.
      earliestAsOf: earliestRecordableDate(),
      latestAsOf: latestRecordableDate(),
    };
  } catch (error) {
    // An earlier step not genuinely passed is a redirect there, not an error:
    // a bookmarked review over a draft whose mapping broke, or whose file
    // still carries a first sighting, resumes where the answer is.
    if (error instanceof DraftNotReadyError) {
      return redirect(`/upload/${params.draftId}/${error.step}`);
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    const written = await commitUpload(params.draftId, values);

    // The statement has committed by now, so the instruments it created and
    // the dates it reaches back to are visible to a refresh — which is why the
    // request is here and not inside `commitUpload`, where a domain function
    // called from a test transaction has committed nothing and would need a
    // provider the tests cannot inject. Not awaited: the person goes to the
    // account page while the batch runs, and the next render prices what it
    // can. Best-effort by design — a request that could not be made is the
    // poller module's log line, never a refused upload.
    requestRefresh();

    // Success lands on the account the upload just changed, with the set id
    // for the receipt — which is read back from the database there, never
    // from this URL.
    throw redirect(`/accounts/${written.accountId}?uploaded=${written.setId}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component: `FORM_ERROR` lives in a `.server`
      // module the client bundle must not drag in.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    if (error instanceof DraftNotReadyError) {
      return redirect(`/upload/${params.draftId}/${error.step}`);
    }
    if (error instanceof NotFoundError) {
      // The committed-draft re-POST — back button after success, resubmitted
      // tab. The draft is gone, so the posted hidden field feeds the expired
      // page's one extra link — never a write — validated as an id here
      // because it arrives from a posted form.
      const accountId =
        values.accountId !== undefined && /^\d+$/.test(values.accountId)
          ? values.accountId
          : null;
      throw data({ accountId }, { status: 404 });
    }
    throw error;
  }
}

/** `$424.1200` — a per-share figure at the column's own four places, or the dash. */
function BasisFigure({ value }: { value: string | null }) {
  return <Amount value={value} places={4} />;
}

function InstrumentCell({ row }: { row: DiffAdded | DiffUpdated | DiffRemoved }) {
  return (
    <td>
      <div className="cell-stack">
        {/* No badge for an instrument with no public ticker — a placeholder in
            a ticker-shaped chip reads as a ticker. */}
        {row.symbol ? <span className="badge">{row.symbol}</span> : null}
        <div>
          {row.name}
          <span className="cell-sub">{row.note}</span>
        </div>
      </div>
    </td>
  );
}

function GroupHeading({ label }: { label: string }) {
  return (
    <tr className="row-group">
      <th scope="rowgroup" colSpan={4}>
        {label}
      </th>
    </tr>
  );
}

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { diff, today, earliestAsOf, latestAsOf } = loaderData;

  const errors = actionData?.errors;
  // What was posted wins over every default on a refusal — a refusal must
  // never cost an edit.
  const values = actionData?.values;

  // Counts in the table's own group order, so the line is its index. A first
  // statement reads "14 ADDED" alone: three zero counts would dress an
  // ordinary first upload as a strange one.
  const summary = diff.firstStatement
    ? `${diff.added.length} ADDED`
    : `${diff.added.length} ADDED · ${diff.updated.length} UPDATED · ${diff.removed.length} REMOVED`;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">What this statement changes</h2>
        <span className="panel-count">{summary}</span>
      </header>

      <div className="panel-body form-intro">
        {/* The file and the account lead: a draft survives a closed laptop
            and the reader may be resuming cold — and this is the point of no
            return, so the account arrives with owner and number tail. */}
        <p>
          <strong>{diff.filename}</strong> · {diff.accountName}
          {diff.accountNumberTail ? ` ${diff.accountNumberTail}` : ""} — owned by{" "}
          {diff.ownerName}
        </p>

        {diff.firstStatement ? (
          <p>
            This is the first statement recorded for {diff.accountName}, so every position in
            it is added — there is nothing yet to have updated or removed.
          </p>
        ) : (
          <p>
            Compared against what {diff.accountName} holds now.
            {/* Unchanged rows are deliberately absent from the table: listing
                rows that do nothing buries the ones that do, and the count is
                all an unchanged row has to say. */}
            {diff.unchangedCount > 0 ? (
              <>
                {" "}
                <span className="u-data">{diff.unchangedCount}</span>{" "}
                {diff.unchangedCount === 1
                  ? "row is unchanged and is not listed."
                  : "rows are unchanged and are not listed."}
              </>
            ) : null}
          </p>
        )}

        {/* A row the parser left out for stating no quantity is named rather
            than silent — a row that vanishes silently is how "a missing row
            means sold" becomes an accident (`SkippedRow`). */}
        {diff.skipped.map((skip) => (
          <p key={skip.row}>
            Line <span className="u-data">{skip.row + 1}</span>'s "{skip.instrument}" states
            no quantity, so it is not part of this statement.
          </p>
        ))}
      </div>

      {/* The diff, in Holdings' table grammar throughout: additions first
          because they read fastest, removals last because they are the reason
          the screen exists and the eye rests where the reading ends. */}
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col" className="is-numeric">
                Quantity
              </th>
              {/* Per share, and the heading says so: the whole-position basis
                  moves whenever the quantity does — the per-share figure is
                  the one the statement actually restated. */}
              <th scope="col" className="is-numeric">
                Cost basis / share
              </th>
              {/* At the current quote — context, not part of the write. */}
              <th scope="col" className="is-numeric">
                Value
              </th>
            </tr>
          </thead>

          {diff.added.length > 0 ? (
            <tbody>
              <GroupHeading label="Added" />
              {diff.added.map((row) => (
                <tr key={row.instrumentId}>
                  <InstrumentCell row={row} />
                  <td className="is-numeric"><Amount value={row.quantity} shape="quantity" /></td>
                  <td className="is-numeric"><BasisFigure value={row.costBasisPerShare} /></td>
                  <td className="is-numeric">
                    <Amount value={row.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          ) : null}

          {diff.updated.length > 0 ? (
            <tbody>
              <GroupHeading label="Updated" />
              {diff.updated.map((row) => (
                <tr key={row.instrumentId}>
                  <InstrumentCell row={row} />
                  {/* Before → after for whatever changed; the unchanged cell
                      prints its single figure. `.diff-was` recedes so the eye
                      lands on what will be true. */}
                  <td className="is-numeric">
                    {row.quantityChanged ? (
                      <>
                        <span className="diff-was"><Amount value={row.quantityBefore} shape="quantity" /></span>{" "}
                        → <Amount value={row.quantityAfter} shape="quantity" />
                      </>
                    ) : (
                      <Amount value={row.quantityAfter} shape="quantity" />
                    )}
                  </td>
                  <td className="is-numeric">
                    {row.basisChanged ? (
                      <>
                        <span className="diff-was"><BasisFigure value={row.costBasisBefore} /></span> →{" "}
                        <BasisFigure value={row.costBasisAfter} />
                      </>
                    ) : (
                      <BasisFigure value={row.costBasisAfter} />
                    )}
                  </td>
                  <td className="is-numeric">
                    <Amount value={row.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          ) : null}

          {diff.removed.length > 0 ? (
            <tbody>
              <GroupHeading label="Removed" />
              {/* Every removed position individually — instrument, quantity,
                  last known value — never collapsed into a count. "1 removed"
                  is recognisable as the AAPL sale only when AAPL is printed. */}
              {diff.removed.map((row) => (
                <tr key={row.instrumentId}>
                  <InstrumentCell row={row} />
                  <td className="is-numeric"><Amount value={row.quantity} shape="quantity" /></td>
                  <td className="is-numeric"><BasisFigure value={row.costBasisPerShare} /></td>
                  {/* A dash, never $0.00, for a holding nothing ever priced —
                      $0.00 would claim the household sold something worthless. */}
                  <td className="is-numeric">
                    <Amount value={row.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>

      <Form method="post">
        {/* Feeds the expired page's link on a re-POST, never a write — the
            draft the id would be read from is gone by then (§6.5, §7.4). */}
        <input type="hidden" name="accountId" value={diff.accountId} />

        {/* The majority-removal confirmation, at the danger-zone weight the
            app closes an account with: a decision put to the reader. Half or
            less draws no confirmation — a tick always demanded is a tick
            nobody reads. */}
        {diff.majorityRemoved ? (
          <div className="danger-zone">
            <label className="choice">
              <input
                type="checkbox"
                name="confirmRemovals"
                value="true"
                defaultChecked={values?.confirmRemovals === "true"}
              />
              <strong>
                {diff.removesEverything ? (
                  <>
                    This file removes every position this account holds — all{" "}
                    <span className="u-data">{diff.currentCount}</span>.
                  </>
                ) : (
                  <>
                    This file removes <span className="u-data">{diff.removed.length}</span> of
                    the <span className="u-data">{diff.currentCount}</span> positions this
                    account holds.
                  </>
                )}
              </strong>
            </label>
          </div>
        ) : null}

        {/* Commit-time refusals — product guard, account-number
            disagreement, closed account, unticked confirmation — all render
            here, above the commit row. */}
        {actionData?.formError ? (
          <div className="panel-body form-intro">
            <p className="form-error" role="alert">
              {actionData.formError}
            </p>
          </div>
        ) : null}

        <div className="panel-form">
          {diff.asOf.source === "file" ? (
            // The statement said it; offering an editor here would invite
            // overriding a fact with an opinion.
            <p className="form-note">
              The statement dates itself: <span className="u-data">{diff.asOf.date}</span>.
            </p>
          ) : (
            <div>
              <label htmlFor="review-as-of">
                Statement date
                <input
                  id="review-as-of"
                  name="asOf"
                  type="date"
                  defaultValue={values?.asOf ?? today}
                  min={earliestAsOf}
                  max={latestAsOf}
                  aria-invalid={errors?.asOf ? true : undefined}
                />
              </label>
              {errors?.asOf ? (
                <p className="field-error" role="alert">
                  {errors.asOf}
                </p>
              ) : (
                <p className="form-note">This file does not date itself.</p>
              )}
            </div>
          )}

          <button type="submit" className="button">
            Record this statement
          </button>
          {/* The misread-column story ends here: see every quantity a thousand
              times too large, walk back, remap, return. Nothing was written,
              because nothing is written before the commit. */}
          <Link className="button button--text" to={`/upload/${diff.draftId}/columns`}>
            Back to columns
          </Link>
        </div>
      </Form>
    </section>
  );
}
