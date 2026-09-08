import { Link } from "react-router";

// DESIGN.md §8.4 names the tabs, not all built yet — names what's coming rather than leaving it unexplained.
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
              How often quotes are refreshed from the price feed around regular market hours.
            </dd>

            <dt>
              <Link to="/settings/display">Display</Link>
            </dt>
            <dd>
              What a browser nobody has touched yet opens in — amounts masked, shown, or as
              that browser last left them.
            </dd>

            <dt>
              <Link to="/settings/passkeys">Passkeys</Link>
            </dt>
            <dd>
              What can unlock a browser once the household holds one — enrol another, see which
              can sync to a family member's other devices, and remove one that is lost for good.
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
