import { Link } from "react-router";

import { AccountNumberTail } from "~/components/account-number-tail";
import { UploadReceiptSentence } from "~/components/upload-receipt";
import { recordedStatements } from "~/lib/uploads.server";

import type { Route } from "./+types/done";

/**
 * Where a multi-account upload lands (spec 0023 decision 16): one line per account it recorded,
 * each linking to that account's own receipt. Read back from `?sets=`, never from the commit, so a
 * reload shows the same page; an id naming no upload set is left out, never a 404.
 */
export function meta() {
  return [{ title: "Recorded · Upload · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return {
    statements: await recordedStatements(new URL(request.url).searchParams.get("sets")),
  };
}

export default function UploadDone({ loaderData }: Route.ComponentProps) {
  const { statements } = loaderData;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Statements recorded</h1>
          <p className="page-subtitle">
            One statement for each account the file names. An open account it does not name is
            left as it is.
          </p>
        </div>
      </header>

      {statements.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-headline">No recorded statement matches this address.</p>
          <p className="empty-state-detail">
            <Link to="/upload">Upload a statement</Link>
          </p>
        </div>
      ) : (
        <section className="panel">
          <header className="panel-header">
            <h2 className="panel-title">{statements[0]?.receipt.filename ?? "The statement"}</h2>
            <span className="panel-count">
              {statements.length} {statements.length === 1 ? "ACCOUNT" : "ACCOUNTS"}
            </span>
          </header>

          <ul className="record-list">
            {statements.map(({ accountId, accountName, ownerName, accountNumberTail, receipt }) => (
              <li key={receipt.setId}>
                <p className="record panel-body">
                  <span>
                    <Link to={`/accounts/${accountId}?uploaded=${receipt.setId}`}>
                      {accountName}
                      <AccountNumberTail tail={accountNumberTail} />
                    </Link>{" "}
                    — owned by {ownerName}:{" "}
                    <UploadReceiptSentence receipt={receipt} accountName={accountName} />
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
