import { EmptyState } from "~/components/empty-state";
import { currentHoldings } from "~/lib/valuation.server";

import type { Route } from "./+types/holdings";

/**
 * Holdings — every position across every account, grouped and filterable.
 *
 * The table is the dashboards slice's. This is the empty case and the count,
 * both read through the shared query module so that this page and Overview
 * cannot disagree about what is currently held (DESIGN.md §8.2).
 */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader() {
  const holdings = await currentHoldings();

  return {
    holdingCount: holdings.length,
    accountCount: new Set(holdings.map((holding) => holding.accountId)).size,
  };
}

export default function Holdings({ loaderData }: Route.ComponentProps) {
  const { holdingCount, accountCount } = loaderData;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Holdings</h1>
          <p className="page-subtitle">
            Every position the household holds, whichever account it sits in.
          </p>
        </div>
      </header>

      {holdingCount === 0 ? (
        <EmptyState>
          Every position across every account will be listed here, grouped and filterable.
          Nothing has been uploaded to this instance yet.
        </EmptyState>
      ) : (
        <p className="page-lede">
          <span className="u-data">{holdingCount}</span> holding
          {holdingCount === 1 ? "" : "s"} across <span className="u-data">{accountCount}</span>{" "}
          account{accountCount === 1 ? "" : "s"} are recorded. The grouped, filterable table is
          built in the dashboards slice.
        </p>
      )}
    </section>
  );
}
