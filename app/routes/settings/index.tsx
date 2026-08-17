import { Link } from "react-router";

/**
 * What Settings holds, and what it will hold.
 *
 * DESIGN.md §8.4 names five tabs; two of them exist in this slice. Saying which
 * three are still coming is the honest version of a fresh install — a family
 * member who cannot find Instruments should learn that it is not built yet
 * rather than conclude they are looking in the wrong place.
 */
export function meta() {
  return [{ title: "Settings · Portfolio" }];
}

export default function SettingsIndex() {
  return (
    <>
      <h1>Settings</h1>
      <p className="page-lede">
        Everything that changes what the app knows, other than uploading a statement.
      </p>

      <dl className="settings-summary">
        <dt>
          <Link to="/settings/people">People</Link>
        </dt>
        <dd>Who is in the household. Every account belongs to exactly one of them.</dd>

        <dt>
          Accounts
        </dt>
        <dd>
          Brokerage, workplace plan, IRA, bank and loan accounts — with an owner, a tax
          treatment, and a closing date when one stops being used.
        </dd>

        <dt>Classifications, Instruments and History</dt>
        <dd>
          Asset labels, ticker and manual-price management, and the hand-typed net worth
          series from before this instance existed. Later slices build these.
        </dd>
      </dl>
    </>
  );
}
