import { Form, Link, data, redirect } from "react-router";

import { AccountNumberTail } from "~/components/account-number-tail";
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
import {
  DraftNotReadyError,
  RefusedUpload,
  STALE_REVIEW_MESSAGE,
  StaleReviewError,
  recordUpload,
  reviewForDraft,
} from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type {
  DiffAdded,
  DiffRemoved,
  DiffSection,
  DiffUpdated,
  UploadDiff,
} from "~/lib/uploads.server";
import type { Route } from "./+types/review";

/**
 * Step four, five for a file of several accounts — the diff, then the commit
 * (ingest brief §6), the flow's only write. §5.2: a missing row means sold,
 * so every removal is listed in full, and removing more than half needs a
 * ticked confirmation. Read-only
 * plus date and tick — mapping errors go back to Columns; source-file errors
 * need a corrected upload because a draft's bytes never change.
 */
export function meta() {
  return [{ title: "Review · Upload · Portfolio" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  try {
    const diff = await reviewForDraft(params.draftId, url.searchParams.get("asOf"));

    return {
      steps: {
        current: diff.accountsSkipped === null ? 4 : 5,
        draftId: diff.draftId,
        // Written by the columns step, the one moment the answer existed — an alias doesn't say which draft wrote it.
        instrumentsSkipped: diff.instrumentsSkipped,
        accountsSkipped: diff.accountsSkipped,
      } satisfies UploadStepsData,
      diff,
      staleReviewMessage:
        url.searchParams.get("stale") === "true" ? STALE_REVIEW_MESSAGE : null,
      earliestAsOf: earliestRecordableDate(),
      latestAsOf: latestRecordableDate(),
    };
  } catch (error) {
    if (error instanceof DraftNotReadyError) {
      if (error.blocked !== null) {
        return {
          steps: {
            current: error.blocked.accountsSkipped === null ? 4 : 5,
            draftId: error.blocked.draftId,
            instrumentsSkipped: error.blocked.instrumentsSkipped,
            accountsSkipped: error.blocked.accountsSkipped,
          } satisfies UploadStepsData,
          diff: null,
          blocked: error.blocked,
          staleReviewMessage: null,
          earliestAsOf: earliestRecordableDate(),
          latestAsOf: latestRecordableDate(),
        };
      }

      const stale = url.searchParams.get("stale") === "true" ? "?stale=true" : "";
      return redirect(`/upload/${params.draftId}/${error.step}${stale}`);
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

// A refusal voids every tick, a multi-account review's per-account ones too, so none is echoed back.
function withoutTicks(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => !/^confirm(Removals|FiledBehind)(-|$)/.test(name)),
  );
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    if (values.intent === "review-date") {
      const diff = await reviewForDraft(params.draftId, values.asOf ?? "");
      if (diff.asOfError !== null) {
        return {
          errors: { asOf: diff.asOfError },
          formError: null,
          values: withoutTicks(values),
          diff,
          confirmationReset: crypto.randomUUID(),
        };
      }
      throw redirect(
        `/upload/${params.draftId}/review?asOf=${encodeURIComponent(diff.asOfInput)}`,
      );
    }

    const written = await recordUpload(params.draftId, values);

    // Here, not inside `recordUpload`: the statement is committed by now, so
    // new instruments are visible to a refresh, and a test transaction
    // wouldn't have a provider to inject. Not awaited — best-effort, never a refused upload.
    try {
      requestRefresh();
    } catch (error) {
      // Structural, not trusted: keeps a future throw here from replacing the success redirect with an error boundary.
      console.error("An upload could not request a refresh; the next tick will price it:", error);
    }

    throw redirect(
      written.multiAccount
        ? `/upload/done?sets=${written.recorded.map((set) => set.setId).join(",")}`
        : `/accounts/${written.recorded.accountId}?uploaded=${written.recorded.setId}`,
    );
  } catch (error) {
    if (error instanceof StaleReviewError) {
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return {
        errors: fieldErrors,
        formError: formError ?? null,
        values: withoutTicks(values),
        diff: error.diff,
        confirmationReset: crypto.randomUUID(),
      };
    }
    if (error instanceof ValidationError) {
      // Split here, not in the component — `FORM_ERROR`'s `.server` module can't reach the client bundle.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      // Carries the diff the refusal was decided against (#181) — the loader's earlier read can
      // predate the account state the commit just refused against.
      let diff: UploadDiff;
      if (error instanceof RefusedUpload) {
        diff = error.diff;
      } else {
        try {
          // A generic guard can fire before commit assembles a diff. Rebuild through the domain so
          // the submitted date and the figures stay one review on this same-page response.
          diff = await reviewForDraft(params.draftId, values.asOf ?? "");
        } catch (reviewError) {
          if (reviewError instanceof DraftNotReadyError) {
            if (reviewError.blocked !== null) {
              return redirect(`/upload/${params.draftId}/review`);
            }
            const stale = values.reviewRevision !== undefined ? "?stale=true" : "";
            return redirect(`/upload/${params.draftId}/${reviewError.step}${stale}`);
          }
          if (reviewError instanceof NotFoundError) {
            const accountId =
              values.accountId !== undefined && /^\d+$/.test(values.accountId)
                ? values.accountId
                : null;
            throw data({ accountId }, { status: 404 });
          }
          throw reviewError;
        }
      }
      return {
        errors: fieldErrors,
        formError: formError ?? null,
        values: withoutTicks(values),
        diff,
        confirmationReset: crypto.randomUUID(),
      };
    }
    if (error instanceof DraftNotReadyError) {
      if (error.blocked !== null) {
        return redirect(`/upload/${params.draftId}/review`);
      }
      const stale = values.reviewRevision !== undefined ? "?stale=true" : "";
      return redirect(`/upload/${params.draftId}/${error.step}${stale}`);
    }
    if (error instanceof NotFoundError) {
      // Committed-draft re-POST — draft is gone, so the hidden field only feeds the expired page's link.
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

// A first statement reads "14 ADDED" alone — three zero counts would dress an ordinary upload as strange.
function summaryOf(section: DiffSection): string {
  return section.firstStatement
    ? `${section.added.length} ADDED`
    : `${section.added.length} ADDED · ${section.updated.length} UPDATED · ` +
        `${section.removed.length} REMOVED`;
}

function Comparison({ section }: { section: DiffSection }) {
  if (section.firstStatement) {
    return (
      <p>
        {section.filedBehind !== null ? (
          <>
            Nothing was recorded for {section.accountName} on or before{" "}
            <span className="u-data">{section.filedBehind.asOf}</span>,
          </>
        ) : (
          <>This is the first statement recorded for {section.accountName},</>
        )}{" "}
        so every position in it is added — there is nothing yet to have updated or removed.
      </p>
    );
  }

  return (
    <p>
      {section.asOf.date !== null ? (
        <>
          Compared against what {section.accountName} held on{" "}
          <span className="u-data">{section.asOf.date}</span>.
        </>
      ) : (
        <>Compared against what {section.accountName} holds now.</>
      )}
      {/* Unchanged rows absent from the table — listing rows that do nothing buries the ones that do. */}
      {section.unchangedCount > 0 ? (
        <>
          {" "}
          <span className="u-data">{section.unchangedCount}</span>{" "}
          {section.unchangedCount === 1
            ? "row is unchanged and is not listed."
            : "rows are unchanged and are not listed."}
        </>
      ) : null}
    </p>
  );
}

// Named rather than silent — a silently vanished row is how "a missing row means sold" becomes an accident.
function SkippedLines({ skipped }: { skipped: DiffSection["skipped"] }) {
  return skipped.map((skip) => (
    <p key={skip.row}>
      Line <span className="u-data">{skip.row + 1}</span>'s "{skip.instrument}" states no
      quantity, so it is not part of this statement.
    </p>
  ));
}

// Additions first (read fastest), removals last (why the screen exists).
function DiffTable({ section }: { section: DiffSection }) {
  // Nothing to list: Comparison's unchanged count says so, and a bare header reads as rows lost.
  if (section.added.length + section.updated.length + section.removed.length === 0) return null;

  return (
    <div className="data-table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Instrument</th>
            <th scope="col" className="is-numeric">
              Quantity
            </th>
            <th scope="col" className="is-numeric">
              Cost basis / share
            </th>
            {/* At the current quote — context, not part of the write. */}
            <th scope="col" className="is-numeric">
              Value
            </th>
          </tr>
        </thead>

        {section.added.length > 0 ? (
          <tbody>
            <GroupHeading label="Added" />
            {section.added.map((row) => (
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

        {section.updated.length > 0 ? (
          <tbody>
            <GroupHeading label="Updated" />
            {section.updated.map((row) => (
              <tr key={row.instrumentId}>
                <InstrumentCell row={row} />
                {/* `.diff-was` recedes so the eye lands on what will be true. */}
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

        {section.removed.length > 0 ? (
          <tbody>
            <GroupHeading label="Removed" />
            {/* Every position individually, never collapsed into a count — "1 removed" needs the name printed. */}
            {section.removed.map((row) => (
              <tr key={row.instrumentId}>
                <InstrumentCell row={row} />
                <td className="is-numeric"><Amount value={row.quantity} shape="quantity" /></td>
                <td className="is-numeric"><BasisFigure value={row.costBasisPerShare} /></td>
                {/* Dash, never $0.00 — that would claim the household sold something worthless. */}
                <td className="is-numeric">
                  <Amount value={row.value} />
                </td>
              </tr>
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

type ConfirmationProps = { section: DiffSection; name: string; resetKey: string };

function FiledBehindConfirmation({ section, name, resetKey }: ConfirmationProps) {
  if (section.filedBehind === null) return null;

  return (
    <div className="danger-zone">
      <label className="choice">
        {/* Keyed on the refusal token, not just `defaultChecked`: React only assigns
            `element.defaultChecked` on a re-render, never `element.checked`
            (react-dom-client.development.js:1675-1678), and HTML's dirty-checkedness flag
            stops the content attribute affecting a box once a person has clicked it. A
            `<Form>` refusal reuses this component instance, so without a key change here a
            ticked box would keep looking ticked after the refusal voided it. No test
            covers this: `renderRoute` (tests/support/render.tsx) calls
            `renderToStaticMarkup` fresh each time, with no persistent fiber tree to
            reconcile against, so a render-only test cannot see a `key` remount either way —
            the safest honest check left is the browser itself. */}
        <input
          key={`${resetKey}:${name}`}
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={false}
        />
        <strong>
          This statement is dated <span className="u-data">{section.filedBehind.asOf}</span>,
          behind the <span className="u-data">{section.filedBehind.currentAsOf}</span> figures{" "}
          {section.accountName} currently reports. Recording it changes this account's history
          between {section.filedBehind.asOf} and the next statement recorded after it, and with
          it the net worth chart over those dates, but it does not change what the account
          holds now.
        </strong>
      </label>
    </div>
  );
}

// Danger-zone weight, same as closing an account — half or less draws no confirmation.
function RemovalConfirmation({ section, name, resetKey }: ConfirmationProps) {
  if (!section.majorityRemoved) return null;

  // "this account holds" is only true of today's holdings — wrong once filed behind means these
  // counts are the baseline's own (uploads.server.ts's matching guard).
  const removalScope =
    section.filedBehind !== null ? (
      <>
        recorded on <span className="u-data">{section.baselineAsOf}</span>
      </>
    ) : (
      "this account holds"
    );

  return (
    <div className="danger-zone">
      <label className="choice">
        {/* Same reason as FiledBehindConfirmation's box: keyed on the refusal so the response
            remounts the box instead of leaving a person's own click stuck behind HTML's
            dirty-checkedness flag. */}
        <input
          key={`${resetKey}:${name}`}
          type="checkbox"
          name={name}
          value="true"
          defaultChecked={false}
        />
        <strong>
          {section.removesEverything ? (
            <>
              This file removes every position {removalScope} — all{" "}
              <span className="u-data">{section.currentCount}</span>.
            </>
          ) : (
            <>
              This file removes <span className="u-data">{section.removed.length}</span> of
              the <span className="u-data">{section.currentCount}</span> positions{" "}
              {removalScope}.
            </>
          )}
        </strong>
      </label>
    </div>
  );
}

function RecordControls({
  diff,
  values,
  errors,
  staleReviewMessage,
  formError,
  earliestAsOf,
  latestAsOf,
}: {
  diff: UploadDiff;
  values: Record<string, string> | undefined;
  errors: Record<string, string> | undefined;
  staleReviewMessage: string | null;
  formError: string | null;
  earliestAsOf: string;
  latestAsOf: string;
}) {
  return (
    <>
      {staleReviewMessage ? (
        <div className="panel-body form-intro">
          <p className="form-error" role="alert">
            {staleReviewMessage}
          </p>
        </div>
      ) : null}

      {formError ? (
        <div className="panel-body form-intro">
          <p className="form-error" role="alert">
            {formError}
          </p>
        </div>
      ) : null}

      <div className="panel-form">
        {diff.asOf.source === "file" ? (
          // Statement said it — an editor here would invite overriding a fact with an opinion.
          diff.accounts !== null ? (
            <p className="form-note">Every account's statement is dated by the file.</p>
          ) : (
            <p className="form-note">
              The statement dates itself: <span className="u-data">{diff.asOf.date}</span>.
            </p>
          )
        ) : (
          <div>
            <label htmlFor="review-as-of">
              Statement date
              <input
                id="review-as-of"
                name="asOf"
                type="date"
                defaultValue={values?.asOf ?? diff.asOfInput}
                min={earliestAsOf}
                max={latestAsOf}
                aria-invalid={errors?.asOf || diff.asOfError ? true : undefined}
              />
            </label>
            {errors?.asOf ?? diff.asOfError ? (
              <p className="field-error" role="alert">
                {errors?.asOf ?? diff.asOfError}
              </p>
            ) : (
              <p className="form-note">
                This file does not date itself. Review a changed date before recording it.
              </p>
            )}
          </div>
        )}

        {diff.asOf.source === "asked" ? (
          <button
            type="submit"
            className="button button--secondary"
            name="intent"
            value="review-date"
          >
            Review this date
          </button>
        ) : null}
        <button type="submit" className="button" disabled={diff.reviewRevision === null}>
          {diff.accounts !== null ? "Record these statements" : "Record this statement"}
        </button>
        {/* Nothing was written yet — safe to walk back and remap. */}
        <Link className="button button--text" to={`/upload/${diff.draftId}/columns`}>
          Back to columns
        </Link>
      </div>
    </>
  );
}

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { earliestAsOf, latestAsOf } = loaderData;

  // Fresh loader state wins over carried action data: if a saved draft has become invalid, an
  // earlier refused diff must not put its removal comparison and Record button back on screen.
  if (loaderData.diff === null) {
    const { blocked } = loaderData;

    return (
      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">This statement cannot be reviewed yet</h2>
        </header>

        <div className="panel-body form-intro">
          <p>
            <strong>{blocked.filename}</strong> ·{" "}
            {blocked.accountName !== null ? (
              <>
                {blocked.accountName}
                {blocked.accountNumberTail ? ` ${blocked.accountNumberTail}` : ""} — owned by{" "}
                {blocked.ownerName}
              </>
            ) : (
              "several accounts"
            )}
          </p>
          {blocked.problems.map((problem, index) => (
            <p
              key={`${problem.row ?? "mapping"}-${problem.column ?? "mapping"}-${index}`}
              className="form-error"
              role="alert"
            >
              {problem.message}
            </p>
          ))}
          {blocked.problems.some((problem) => problem.code === "blank-instrument") ? (
            <p>
              Go back to change the column mapping if the instrument is in another column. If the
              instrument is missing from the source row, edit the CSV outside Portfolio and upload
              the corrected file. This draft keeps the original file.
            </p>
          ) : (
            <p>
              Go back to change the column mapping if a column was chosen wrongly. A fault in the
              file itself needs the CSV edited outside Portfolio and the corrected file uploaded.
              This draft keeps the original file.
            </p>
          )}
        </div>

        <div className="panel-form">
          <Link className="button" to={`/upload/${blocked.draftId}/columns`}>
            Back to columns
          </Link>
          {/* No one account to prefill for a multi-account draft — plain /upload. */}
          <Link
            className="button button--text"
            to={blocked.accountId !== null ? `/upload?account=${blocked.accountId}` : "/upload"}
          >
            Upload corrected file
          </Link>
        </div>
      </section>
    );
  }

  // The refusal's own diff when there was one (#181) — the loader can hold the earlier account
  // state the commit just refused against.
  const diff: UploadDiff = actionData?.diff ?? loaderData.diff;

  const errors = actionData?.errors;
  const values = actionData?.values;
  const resetKey = [diff.reviewRevision ?? "invalid", actionData?.confirmationReset ?? "loader"].join(
    ":",
  );

  const controls = (
    <RecordControls
      diff={diff}
      values={values}
      errors={errors}
      staleReviewMessage={loaderData.staleReviewMessage}
      formError={actionData?.formError ?? null}
      earliestAsOf={earliestAsOf}
      latestAsOf={latestAsOf}
    />
  );

  if (diff.accounts !== null) {
    const count = diff.accounts.length;

    return (
      <section className="panel">
        <header className="panel-header">
          <h2 className="panel-title">What this file changes</h2>
          <span className="panel-count">
            {count} {count === 1 ? "ACCOUNT" : "ACCOUNTS"}
          </span>
        </header>

        <div className="panel-body form-intro">
          <p>
            <strong>{diff.filename}</strong> · several accounts
          </p>
          <p>An open account this file does not name is left as it is.</p>
          {diff.skippedNumbers.length > 0 ? (
            <p>
              The rows of account {diff.skippedNumbers.length === 1 ? "number" : "numbers"}{" "}
              <span className="u-data">{diff.skippedNumbers.join(", ")}</span> were skipped at
              the accounts step, so they are not recorded.
            </p>
          ) : null}
          <SkippedLines skipped={diff.skipped} />
        </div>

        <Form method="post">
          {diff.accounts.map((section) => (
            // The heading, not the bare name: two accounts can share one.
            <section key={section.accountId} aria-labelledby={`account-${section.accountId}`}>
              <header className="panel-header">
                <h3 className="panel-title" id={`account-${section.accountId}`}>
                  <span>
                    {section.accountName}
                    <AccountNumberTail tail={section.accountNumberTail} /> — owned by{" "}
                    {section.ownerName}
                  </span>
                </h3>
                <span className="panel-count">{summaryOf(section)}</span>
              </header>

              <div className="panel-body form-intro">
                <p>
                  {section.asOf.source === "file" ? (
                    <>
                      The file dates this statement{" "}
                      <span className="u-data">{section.asOf.date}</span>.
                    </>
                  ) : (
                    <>The file does not date this statement, so it takes the date below.</>
                  )}
                </p>
                <Comparison section={section} />
                <SkippedLines skipped={section.skipped} />
              </div>

              <DiffTable section={section} />

              {/* Its own binding and ticks, suffixed with its id (uploads.server.ts CommitInput). */}
              <input
                type="hidden"
                name={`baselineSetId-${section.accountId}`}
                value={section.baselineSetId ?? ""}
              />
              <input
                type="hidden"
                name={`appendWatermark-${section.accountId}`}
                value={section.appendWatermark ?? ""}
              />
              <FiledBehindConfirmation
                section={section}
                name={`confirmFiledBehind-${section.accountId}`}
                resetKey={resetKey}
              />
              <RemovalConfirmation
                section={section}
                name={`confirmRemovals-${section.accountId}`}
                resetKey={resetKey}
              />
            </section>
          ))}

          <input type="hidden" name="accountId" value="" />
          {diff.reviewRevision !== null ? (
            <input type="hidden" name="reviewRevision" value={diff.reviewRevision} />
          ) : null}
          <input type="hidden" name="reviewedAsOf" value={diff.asOfInput} />

          {controls}
        </Form>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">What this statement changes</h2>
        <span className="panel-count">{summaryOf(diff)}</span>
      </header>

      <div className="panel-body form-intro">
        <p>
          <strong>{diff.filename}</strong> ·{" "}
          {diff.accountName !== null ? (
            <>
              {diff.accountName}
              {diff.accountNumberTail ? ` ${diff.accountNumberTail}` : ""} — owned by{" "}
              {diff.ownerName}
            </>
          ) : (
            "several accounts"
          )}
        </p>

        <Comparison section={diff} />
        <SkippedLines skipped={diff.skipped} />
      </div>

      <DiffTable section={diff} />

      <Form method="post">
        {/* Feeds the expired page's link on a re-POST, never a write (§6.5, §7.4). */}
        <input type="hidden" name="accountId" value={diff.accountId ?? ""} />
        {/* The confirmation's binding (#181) — "" is null's wire form, so a first statement's
            missing baseline round-trips as the empty string on every side of the comparison. */}
        <input type="hidden" name="baselineSetId" value={diff.baselineSetId ?? ""} />
        {diff.reviewRevision !== null ? (
          <input type="hidden" name="reviewRevision" value={diff.reviewRevision} />
        ) : null}
        <input type="hidden" name="reviewedAsOf" value={diff.asOfInput} />

        <FiledBehindConfirmation section={diff} name="confirmFiledBehind" resetKey={resetKey} />
        <RemovalConfirmation section={diff} name="confirmRemovals" resetKey={resetKey} />

        {controls}
      </Form>
    </section>
  );
}
