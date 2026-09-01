import { Form, Link } from "react-router";

import { AccountFields } from "~/components/account-fields";
import { AccountNumberTail } from "~/components/account-number-tail";
import { numberTail } from "~/lib/account-label";
import { createAccount, listAccounts } from "~/lib/accounts.server";
import { NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import { listPeople } from "~/lib/people.server";

import type { Route } from "./+types/accounts";

/**
 * Settings → Accounts: the list, and the form that adds to it. Editing and
 * closing are their own screen (`account.tsx`) — an account carries six
 * fields, and closing is a decision historical figures are computed against;
 * neither belongs behind an inline control on a list.
 */
export function meta() {
  return [{ title: "Accounts · Settings · Portfolio" }];
}

export async function loader() {
  const [accounts, people] = await Promise.all([listAccounts(), listPeople()]);
  return {
    // The list renders only the tail, so only the tail is serialized to the
    // browser; the edit screen loads the raw number itself, being its editor.
    accounts: accounts.map(({ externalAccountNumber, ...account }) => ({
      ...account,
      accountNumberTail: numberTail(externalAccountNumber),
    })),
    people,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const values = formFields(await request.formData());

  try {
    await createAccount(values);
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return { errors: error.fieldErrors, values };
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

/** UTC, and formatted on the server: the database stores UTC and a date
 *  formatted in the browser's locale would differ between the server-rendered
 *  markup and the hydrated one. */
const closedOn = (closedAt: Date | null): string | null =>
  closedAt === null ? null : new Date(closedAt).toISOString().slice(0, 10);

export default function Accounts({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, people } = loaderData;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Accounts</h1>
          <p className="page-subtitle">
            Every account the household holds — brokerage, workplace plan, IRA, bank and loan.
            This is what an uploaded statement lands in.
          </p>
        </div>
      </header>

      {accounts.length === 0 ? (
        <p className="empty-note">No accounts are recorded yet.</p>
      ) : (
        <section className="panel">
          <div className="data-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Institution</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Tax treatment</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr
                    key={account.id}
                    className={account.isClosed ? "record-row--closed" : undefined}
                  >
                    <td>
                      <Link to={`/settings/accounts/${account.id}`}>
                        {account.name}
                        <AccountNumberTail tail={account.accountNumberTail} />
                      </Link>
                    </td>
                    <td>{account.institution || "—"}</td>
                    <td>{account.kind}</td>
                    <td>{account.ownerName}</td>
                    <td>{account.taxTreatment.replace("_", "-")}</td>
                    <td>
                      {account.isClosed ? (
                        <>
                          Closed <span className="u-data">{closedOn(account.closedAt) ?? ""}</span>
                        </>
                      ) : (
                        "Open"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {people.length === 0 ? (
        // An account cannot exist without an owner, so this is the one place
        // the first-run order is enforced rather than merely suggested.
        <p className="empty-note">
          Add someone under <Link to="/settings/people">People</Link> first — every account
          belongs to exactly one person.
        </p>
      ) : (
        <section className="panel">
          <header className="panel-header">
            <h2 className="panel-title">Add an account</h2>
          </header>

          <Form method="post" className="panel-form">
            <AccountFields
              people={people}
              values={actionData?.values}
              errors={actionData?.errors}
              idPrefix="new-account"
            />

            <button type="submit" className="button">
              Add account
            </button>
          </Form>
        </section>
      )}
    </>
  );
}
