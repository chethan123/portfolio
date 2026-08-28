import { Link } from "react-router";

/**
 * What Settings holds, and what it will hold.
 *
 * DESIGN.md §8.4 names the tabs; not all of them exist yet. Saying which are
 * still coming is the honest version of a fresh install — a family member who
 * cannot find Instruments should learn that it is not built yet rather than
 * conclude they are looking in the wrong place.
 */
export function meta() {
  return [{ title: "Settings · Portfolio" }];
}

export default function SettingsIndex() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Everything that changes what the app knows, other than uploading a statement.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-body">
          <dl className="settings-summary">
            <dt>
              <Link to="/settings/people">People</Link>
            </dt>
            <dd>Who is in the household. Every account belongs to exactly one of them.</dd>

            <dt>
              <Link to="/settings/accounts">Accounts</Link>
            </dt>
            <dd>
              Brokerage, workplace plan, IRA, bank and loan accounts — with an owner, a tax
              treatment, and a closing date when one stops being used.
            </dd>

            <dt>
              <Link to="/settings/tax">Tax</Link>
            </dt>
            <dd>
              The capital gains rate the Analysis screen uses to estimate what settling an
              unrealized gain in a taxable account would cost.
            </dd>

            <dt>
              <Link to="/settings/prices">Prices</Link>
            </dt>
            <dd>
              How often quotes are refreshed from the price feed while the market is open.
            </dd>

            <dt>
              <Link to="/settings/display">Display</Link>
            </dt>
            <dd>
              What a browser nobody has touched yet opens in — amounts masked, shown, or as
              that browser last left them.
            </dd>

            <dt>Classifications, Instruments and History</dt>
            <dd>
              Asset labels, ticker and manual-price management, and the hand-typed net worth
              series from before this instance existed. Later slices build these.
            </dd>
          </dl>
        </div>
      </section>
    </>
  );
}
