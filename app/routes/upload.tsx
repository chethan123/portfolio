import { Form, Link, redirect } from "react-router";

import { UploadSteps } from "~/components/upload-steps";
import { accountPickerGroups } from "~/lib/account-label";
import { listAccounts } from "~/lib/accounts.server";
import { FORM_ERROR, NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { createDraft, parseUploadForm, refuseOversizedBody } from "~/lib/uploads.server";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/upload";

/**
 * The drop screen — step one of the upload flow (DESIGN.md §5.1, ingest
 * brief §3). Pick which account this statement describes, hand over the file,
 * land on the mapping step. One decision and one control; everything hard
 * comes later, and the screen is built to look like that is true.
 *
 * The POST is the application's first multipart form. Its guards — the size
 * cap read twice, the empty file, the not-text file — live in
 * `uploads.server.ts`, so this action stays the same thin translation every
 * other route is.
 */
export function meta() {
  return [{ title: "Upload · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const accounts = await listAccounts();

  const openAccounts = accounts.filter((account) => !account.isClosed);

  // `?account=` is a prefill (CONTEXT.md), not a filter: a link from an
  // account's own page hands the selector its starting choice, still
  // changeable, committing nothing. One that names anything the select does
  // not offer — closed, gone, mistyped — is quietly dropped and the form
  // starts blank, because a prefill only ever saved the picking; it never
  // promised the pick. Matched against the options here so the select is
  // never defaulted to a value no option carries.
  const requested = new URL(request.url).searchParams.get("account");
  const prefillAccountId = openAccounts.some((account) => account.id === requested)
    ? requested
    : null;

  return {
    // The same query as Settings, so the two screens can never disagree about
    // what the accounts are called; within each owner's group the options
    // keep that order. The groups themselves follow the People screen, and
    // which facts an option shows is `account-label.ts`'s one rule. Closed
    // accounts are absent, not disabled: their history does not change, and a
    // disabled option is a question a select cannot answer.
    accountGroups: accountPickerGroups(openAccounts),
    hasAccounts: accounts.length > 0,
    maxUploadMb: getConfig().MAX_UPLOAD_MB,
    prefillAccountId,
  };
}

export async function action({ request }: Route.ActionArgs) {
  let values: Record<string, string> = {};

  try {
    // Before the body is read: `formData()` buffers the whole thing.
    refuseOversizedBody(request);

    const form = await request.formData();
    values = formFields(form);

    // The file part is read from the form directly — `formFields` drops file
    // parts by design, and that stays its job.
    const input = await parseUploadForm(form);
    const draft = await createDraft(input);

    throw redirect(`/upload/${draft.id}/columns`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Split here, not in the component, for the reason people.tsx gives:
      // `FORM_ERROR` lives in a `.server` module the client bundle must not
      // drag in. The account choice comes back with the refusal; the chosen
      // file inevitably does not, because a browser will not refill a file
      // input.
      const { [FORM_ERROR]: formError, ...fieldErrors } = error.fieldErrors;
      return { errors: fieldErrors, formError: formError ?? null, values };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Upload({ loaderData, actionData }: Route.ComponentProps) {
  const { accountGroups, hasAccounts, maxUploadMb, prefillAccountId } = loaderData;
  const errors = actionData?.errors;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Upload a statement</h1>
          <p className="page-subtitle">
            A statement lands as one photograph of what the account holds. Nothing is recorded
            until the last step.
          </p>
        </div>
      </header>

      <UploadSteps steps={{ current: 1, draftId: null, instrumentsSkipped: false }} />

      {!hasAccounts ? (
        // The shell already renders the first-run prompt on this page, and it
        // is the app's one pointer at the next step — a second voice here would
        // double it, and a select over nothing would explain less than nothing.
        null
      ) : accountGroups.length === 0 ? (
        // Not the first-run prompt: the household is set up, and "start here"
        // would be false. No form either — a file input that can lead nowhere
        // is a dead control.
        <div className="empty-state">
          <p className="empty-state-headline">Every account is closed.</p>
          <p className="empty-state-detail">
            A statement lands in an open account, and a closed account's history does not
            change. Reopen or add one under{" "}
            <Link to="/settings/accounts">Settings → Accounts</Link>.
          </p>
        </div>
      ) : (
        <section className="panel">
          <div className="panel-body form-intro">
            <p>
              Map the file's columns once per institution — the mapping is remembered and
              applied to every later export with the same header. Anything the file names that
              has never been seen before is resolved once, then remembered forever.
            </p>
            <p>
              The last step shows exactly what this statement changes — every removal listed in
              full — and nothing is recorded until it is committed there.
            </p>

            {actionData?.formError ? (
              <p className="form-error" role="alert">
                {actionData.formError}
              </p>
            ) : null}
          </div>

          <Form method="post" encType="multipart/form-data" className="panel-form">
            <div>
              <label htmlFor="upload-account">
                Account
                {/* A refusal outranks the link's prefill even empty-handed —
                    the size cap refuses on the Content-Length header before
                    any field is read — because the reader may have changed the
                    account before submitting, and re-applying the prefill
                    would quietly aim the retry at the link's account. The key
                    remounts this uncontrolled select when the effective
                    prefill changes: same-route navigation (the rail's Upload
                    pressed over an ?account= address) reuses the mounted
                    component, where a changed defaultValue alone would leave
                    the old choice standing. */}
                <select
                  key={prefillAccountId ?? ""}
                  id="upload-account"
                  name="accountId"
                  defaultValue={
                    actionData ? (actionData.values.accountId ?? "") : (prefillAccountId ?? "")
                  }
                  aria-invalid={errors?.accountId ? true : undefined}
                >
                  <option value="">Choose…</option>
                  {accountGroups.map((group) => (
                    <optgroup key={group.ownerId} label={`Owned by ${group.ownerName}`}>
                      {group.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {errors?.accountId ? (
                <p className="field-error" role="alert">
                  {errors.accountId}
                </p>
              ) : null}
            </div>

            <div>
              <label htmlFor="upload-file">
                Statement file
                <input
                  id="upload-file"
                  type="file"
                  name="file"
                  accept=".csv,text/csv"
                  aria-invalid={errors?.file ? true : undefined}
                />
              </label>
              {/* The number comes from configuration, never restated by hand:
                  a hardcoded "10 MB" is wrong the day an operator changes the
                  knob. */}
              <p className="field-note">
                Statements up to <span className="u-data">{maxUploadMb}</span> MB.
              </p>
              {errors?.file ? (
                <p className="field-error" role="alert">
                  {errors.file}
                </p>
              ) : null}
            </div>

            <button type="submit" className="button">
              Continue to columns
            </button>
          </Form>
        </section>
      )}
    </section>
  );
}
