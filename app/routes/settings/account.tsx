import { Form, Link, redirect } from "react-router";

import { AccountFields } from "~/components/account-fields";
import { closeAccount, getAccount, updateAccount } from "~/lib/accounts.server";
import { FORM_ERROR, NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { listPeople } from "~/lib/people.server";

import type { Route } from "./+types/account";

/**
 * One account: correct it, or close it.
 *
 * Closing is a separate submission from saving, with its own button and its own
 * warning, because the two do very different things to a figure — a save fixes
 * what an account is, and a close changes which dates it counts on. And because
 * closing is one-way in this version, the button alone is not enough: the
 * domain refuses a close whose acknowledgement was not ticked, so a stray
 * activation of the button changes nothing. Nothing on this page deletes
 * anything; there is no delete affordance in the application at all.
 */
export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.account.name ?? "Account"} · Settings · Portfolio` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const [account, people] = await Promise.all([getAccount(params.accountId), listPeople()]);
    return { account, people };
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    if (values.intent === "close") {
      await closeAccount(params.accountId, values);
      // Back to the list, where the account now reads as closed. Staying here
      // would leave a form open on an account that has just been retired.
      throw redirect("/settings/accounts");
    }

    await updateAccount(params.accountId, values);
    return { saved: true, errors: undefined, values: undefined, closeError: undefined };
  } catch (error) {
    if (error instanceof ValidationError) {
      // A refused close reports beside its own checkbox and leaves the save
      // form alone: the close POST carries no account fields, so echoing it as
      // `values` would blank every box above.
      if (values.intent === "close") {
        return {
          saved: false,
          errors: undefined,
          values: undefined,
          closeError: error.fieldErrors[FORM_ERROR],
        };
      }
      return { saved: false, errors: error.fieldErrors, values, closeError: undefined };
    }
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function AccountDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { account, people } = loaderData;

  // What was typed wins over what is stored, so a refusal never costs an edit.
  const values = actionData?.values ?? {
    name: account.name,
    institution: account.institution,
    kind: account.kind,
    ownerId: account.ownerId,
    taxTreatment: account.taxTreatment,
    externalAccountNumber: account.externalAccountNumber ?? "",
  };

  return (
    <>
      <p className="breadcrumb">
        <Link to="/settings/accounts">← All accounts</Link>
      </p>

      <header className="page-header">
        <div>
          <h1 className="page-title">{account.name}</h1>
          {account.isClosed ? (
            <p className="page-subtitle">
              This account is closed. It no longer counts toward current net worth, and it
              still counts on every date before it closed.
            </p>
          ) : (
            <p className="page-subtitle">
              Correcting a tax treatment here changes every figure computed from this account.
            </p>
          )}
        </div>
      </header>

      {actionData?.saved ? (
        <p className="form-note" role="status">
          Saved.
        </p>
      ) : null}

      {/* One panel, two forms. The danger zone carries the hairline that
          separates it from the fields above, so putting it in a card of its own
          would leave that rule floating at the top of an empty edge. */}
      <section className="panel">
        <Form method="post" className="panel-form">
          <AccountFields
            people={people}
            values={values}
            errors={actionData?.errors}
            idPrefix={`account-${account.id}`}
          />

          <button type="submit" className="button">
            Save changes
          </button>
        </Form>

        {account.isClosed ? null : (
          <Form method="post" className="danger-zone">
            <div>
              <h2 className="panel-title">Close this account</h2>
              <p className="form-note">
                Every figure for a date before today keeps counting this account. Accounts are
                never deleted, so closing is how one is retired.
              </p>
            </div>
            {/* The acknowledgement `closeAccount` requires before its one-way
                write — the tick carries the decision and its consequences, the
                same weight the upload review gives a majority removal. */}
            <label className="choice">
              <input type="checkbox" name="confirmClose" value="true" />
              <strong>
                Close {account.name}: today becomes its closing date, it stops counting toward
                current net worth from now on, and it cannot be reopened in this version.
              </strong>
            </label>
            {actionData?.closeError ? (
              <p className="form-error" role="alert">
                {actionData.closeError}
              </p>
            ) : null}
            <button
              type="submit"
              name="intent"
              value="close"
              className="button button--danger"
            >
              Close {account.name}
            </button>
          </Form>
        )}
      </section>
    </>
  );
}
