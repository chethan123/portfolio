import { Form, Link, redirect } from "react-router";

import { EmptyState } from "~/components/empty-state";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  TrendingFlatIcon,
} from "~/components/icons";
import { formatMoney, formatSignedMoney, isNegative } from "~/lib/format";
import { formatShare } from "~/lib/allocation";
import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  DIMENSIONS,
  type DimensionId,
  type HoldingsQuery,
  type SortDirection,
  type SortKey,
  applyFilters,
  availableFilters,
  formatQuantity,
  groupHoldings,
  holdingNote,
  parseQuery,
  sortHoldings,
  summarise,
  toSearch,
} from "~/lib/holdings-view";
import { MONEY_SCALE, render, toUnits } from "~/lib/money";
import { currentHoldings } from "~/lib/valuation.server";

import type { Route } from "./+types/holdings";

/**
 * Holdings — every position across every account, grouped and filterable.
 *
 * DESIGN.md §8.1's workhorse: "a groupable, filterable Holdings table absorbs
 * what would otherwise be four more pages — by person, by account, tax view,
 * unrealized. Those are the same table with the grouping changed, not separate
 * features."
 *
 * The whole screen is one query and one array. `currentHoldings()` returns the
 * rows; `holdings-view.ts` filters, sorts, groups and totals them without
 * touching the database again, because every dimension is already a column on
 * the row (§8.2). Nothing here can disagree with Overview or Account detail
 * about what is currently held, and no subtotal here can disagree with the rows
 * printed above it.
 *
 * **No client-side state.** Every control is a link or a GET form, and the view
 * is entirely described by the query string — the same arrangement Overview's
 * range control uses, and for the same reasons: it works with JavaScript off, a
 * chosen view survives a reload, and it can be bookmarked or sent to the other
 * person in the household. The application has no React state anywhere and a
 * filter bar is not the place to start.
 */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);

  // Canonicalise the URL before rendering anything.
  //
  // A GET form submits every control it holds, including the ones nobody
  // touched, so pressing Apply with one filter chosen arrives here as
  // `?owner=1&account=&institution=&kind=&tax=&classification=&assetClass=`.
  // That is the URL a person would then bookmark or send to the other person in
  // the household, and it is unreadable. `toSearch` already knows what the
  // minimal spelling of a view is — it omits every default so that the
  // unfiltered table is bare `/holdings` — so the fix is to bounce once to
  // whatever it says rather than to teach the form not to submit.
  //
  // This also drops parameters that mean nothing here, which is the same
  // reading `parseQuery` gives them. The bounce cannot loop: `toSearch` is
  // deterministic and `parseQuery(toSearch(q))` is `q`, so the second pass is
  // already canonical.
  // Grouping hides the column it grouped by, so a URL that sorts by that same
  // column leaves the table ordered by a heading nobody can see: no caret, no
  // `aria-sort`, and no control to reverse it. Fall back to the default sort,
  // and do it here rather than in the component so the URL stops claiming a
  // sort the screen is not applying.
  if (query.group !== null && !columnsFor(query.group).some((column) => column.key === query.sort)) {
    query.sort = DEFAULT_SORT;
    query.direction = DEFAULT_DIRECTION;
  }

  const canonical = toSearch(query);
  if (url.search !== canonical) throw redirect(`${url.pathname}${canonical}`);

  const holdings = await currentHoldings();

  // The filter controls are built from *every* holding, not from the filtered
  // set: options that vanished as you narrowed would leave no way to widen
  // again.
  const filters = availableFilters(holdings, query);
  const visible = applyFilters(holdings, query);

  return {
    // Distinguishes "nothing uploaded" from "this filter matched nothing" —
    // two states that must not share a screen (§8.4).
    hasHoldings: holdings.length > 0,
    totalHoldings: holdings.length,
    accountCount: new Set(visible.map((holding) => holding.accountId)).size,
    filters,
    // A `Map` does not survive the trip to the browser; the component rebuilds
    // one from these pairs.
    active: [...query.filters] as Array<[DimensionId, string]>,
    group: query.group,
    sort: query.sort,
    direction: query.direction,
    groups:
      query.group === null
        ? null
        : groupHoldings(visible, query.group, query.sort, query.direction),
    rows: query.group === null ? sortHoldings(visible, query.sort, query.direction) : null,
    total: summarise(visible),
  };
}

type Holding = NonNullable<Route.ComponentProps["loaderData"]["rows"]>[number];
type Total = Route.ComponentProps["loaderData"]["total"];
type Group = NonNullable<Route.ComponentProps["loaderData"]["groups"]>[number];

type Column = { key: SortKey; label: string; numeric: boolean };

/** The columns, and which of them a header can sort by. */
const COLUMNS: ReadonlyArray<Column> = [
  { key: "asset", label: "Asset", numeric: false },
  { key: "account", label: "Account", numeric: false },
  { key: "owner", label: "Owner", numeric: false },
  { key: "quantity", label: "Quantity", numeric: true },
  { key: "price", label: "Price", numeric: true },
  { key: "value", label: "Value", numeric: true },
  { key: "costBasis", label: "Cost basis", numeric: true },
  { key: "unrealized", label: "Unrealized", numeric: true },
];

/** The three money columns a subtotal and the grand total have figures for. */
const FIGURES = 3;

/**
 * Grouping by owner puts the owner's name in the heading above the group, so
 * repeating it on all fourteen rows beneath says nothing and costs the Asset
 * column the width it needs. The same goes for grouping by account. No other
 * dimension has a column of its own — institution and classification ride as
 * sub-lines — so no other grouping drops one.
 */
function columnsFor(group: DimensionId | null): ReadonlyArray<Column> {
  if (group === "owner") return COLUMNS.filter((column) => column.key !== "owner");
  if (group === "account") return COLUMNS.filter((column) => column.key !== "account");

  return COLUMNS;
}

/**
 * A first click on a money column should show the biggest positions and a first
 * click on a name should start at A. Both are what the word on the header means
 * to a person reading it.
 */
function firstDirection(column: SortKey): SortDirection {
  return COLUMNS.find((entry) => entry.key === column)?.numeric === true ? "desc" : "asc";
}

/**
 * A gain, a loss or neither — decided on the figure that will be *printed*, not
 * on the one behind it.
 *
 * The stored value has four decimal places and the cell shows two, so an
 * unrealized gain of `-0.0040` is a loss by the digits and `$0.00` by the time
 * `formatSignedMoney` has rounded it — whose own guard then suppresses the sign
 * on a zero. Classifying before rounding therefore paints a red down-arrow
 * beside an unsigned `$0.00`, which leaves the arrow and the hue carrying a
 * claim the text does not make: exactly the "never colour alone" rule §12
 * states. Rounding first, through the same half-away-from-zero the formatter
 * uses, keeps the three channels saying one thing.
 *
 * Flat is its own case rather than being folded into gain: a position that has
 * not moved painted green with an up arrow would say it had.
 */
function Delta({ amount }: { amount: string }) {
  const shown = render(toUnits(amount, 2), 2);
  const flat = toUnits(amount, 2) === 0n;
  const down = !flat && isNegative(shown);
  const Arrow = flat ? TrendingFlatIcon : down ? ArrowDownIcon : ArrowUpIcon;

  return (
    // Sign, then arrow, then hue — readable with no colour perception at all
    // (§12). `--bare` because a tinted pill on every row is noise.
    <span
      className={`delta delta--bare ${flat ? "delta--flat" : down ? "delta--loss" : "delta--gain"}`}
    >
      <Arrow />
      {formatSignedMoney(amount)}
    </span>
  );
}

/** A money cell: the figure, or a dash where there is nothing to show. */
function Money({ amount }: { amount: string | null }) {
  return <>{amount === null ? "—" : formatMoney(amount)}</>;
}

export default function Holdings({ loaderData }: Route.ComponentProps) {
  const {
    hasHoldings,
    totalHoldings,
    accountCount,
    filters,
    active,
    group,
    sort,
    direction,
    groups,
    rows,
    total,
  } = loaderData;

  const query: HoldingsQuery = { filters: new Map(active), group, sort, direction };
  const shown = total.valueCoverage.total;
  const filtered = active.length > 0;

  // Clearing the filters clears the filters. The grouping and the sort are how
  // you were reading the table rather than what you were reading, and the form
  // above already carries them through an Apply for exactly that reason — a
  // "Clear" beside it that quietly threw them away would undo more than it
  // says.
  const cleared = toSearch({ ...query, filters: new Map() }) || ".";
  const columns = columnsFor(group);
  const span = columns.length;
  const labelSpan = span - FIGURES;

  if (!hasHoldings) {
    return (
      <section className="page">
        <Header />
        <EmptyState>
          Every position across every account will be listed here, grouped and filterable.
          Nothing has been uploaded to this instance yet.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page">
      <Header />

      <Filters filters={filters} query={query} />
      <GroupBy query={query} />

      <div className="panel">
        <header className="panel-header">
          <h2 className="panel-title">{group === null ? "All holdings" : groupTitle(group)}</h2>
          <p className="panel-count u-data">
            {shown} holding{shown === 1 ? "" : "s"} · {accountCount} account
            {accountCount === 1 ? "" : "s"}
            {/* Without this a filtered table looks like the whole portfolio to
                anyone who did not set the filter — including you, a day later,
                following your own bookmark. */}
            {filtered ? ` · filtered from ${totalHoldings}` : null}
          </p>
        </header>

        {shown === 0 ? (
          // Not the empty state above. The instance has data; this particular
          // question has no answer, and saying "there is no data yet" would be
          // a different and false claim.
          <div className="panel-body">
            <p className="empty-note">
              {describe(filters)} <Link to={cleared}>Clear filters</Link> to see all{" "}
              <span className="u-data">{totalHoldings}</span> again.
            </p>
          </div>
        ) : (
          <>
            <div className="data-table-scroll">
              {/* Explicit roles, matching the implicit ones exactly.
                    Below 768px the stylesheet reflows this table to cards with
                    `display: block`, and browsers drop a table's implicit ARIA
                    roles when they do — taking `scope`, `aria-sort` and every
                    header-to-cell association with them, so a screen reader on
                    a phone would get a pile of unlabelled text held together
                    only by CSS-generated `::before` captions. Spelling the
                    roles out costs nothing on desktop, where they are what the
                    elements already mean. */}
                <table className="data-table data-table--holdings" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    {columns.map((column) => (
                      <SortHeader key={column.key} column={column} query={query} />
                    ))}
                  </tr>
                </thead>

                {groups === null ? (
                  <tbody role="rowgroup">
                    {rows?.map((holding) => (
                      <Row
                        key={`${holding.accountId}-${holding.instrumentId}`}
                        holding={holding}
                        columns={columns}
                      />
                    ))}
                  </tbody>
                ) : (
                  groups.map((entry) => (
                    <GroupBody
                      key={entry.key}
                      group={entry}
                      columns={columns}
                      span={span}
                      labelSpan={labelSpan}
                    />
                  ))
                )}

                <tfoot role="rowgroup">
                  <tr className="row-total" role="row">
                    <th scope="row" colSpan={labelSpan} role="rowheader">
                      Total
                    </th>
                    <Figures total={total} />
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="panel-body">
              <Coverage total={total} grouped={groups !== null} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Why the table is empty, in words — "Nothing in the portfolio is owned by Bob
 * and at Chase."
 *
 * An empty result that only says "no holding matches every filter at once"
 * leaves the reader looking back up at seven dropdowns to work out which pair
 * cannot coexist. The controls know their own chosen option and each dimension
 * knows how to say itself in a sentence, so the screen can name them.
 *
 * The stale-key case gets its own words. "Nothing is owned by Bob and at Chase"
 * is a fact about the portfolio; a filter pointing at an account that has since
 * been closed is a fact about the URL, and telling the reader to look for an
 * overlap that was never the problem would waste their time.
 */
function describe(filters: Route.ComponentProps["loaderData"]["filters"]): string {
  const absent = filters.filter((filter) => filter.selectedIsAbsent);

  if (absent.length > 0) {
    const named = join(absent.map((filter) => filter.label.toLowerCase()));

    return `The ${named} filter names something this portfolio does not hold — the link may predate a change to it.`;
  }

  const chosen = filters
    .map((filter) => filter.selectedPhrase)
    .filter((phrase): phrase is string => phrase !== null);

  if (chosen.length === 0) return "Nothing is held at all.";
  if (chosen.length === 1) return `Nothing in the portfolio is ${chosen[0]}.`;

  return `No holding matches every filter at once. Nothing in the portfolio is ${join(chosen)}.`;
}

/** `["a", "b", "c"]` → `"a, b and c"`. */
function join(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";

  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function Header() {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">Holdings</h1>
        <p className="page-subtitle">
          Every position the household holds, whichever account it sits in.
        </p>
      </div>
    </header>
  );
}

function groupTitle(group: DimensionId): string {
  return `Grouped by ${(DIMENSIONS.find((dimension) => dimension.id === group)?.label ?? group).toLowerCase()}`;
}

/**
 * The filter bar.
 *
 * A plain GET form: the selects write the query string the loader already
 * reads, so the control needs no JavaScript and the resulting view is a URL.
 * The grouping and the sort ride along as hidden fields, because narrowing to
 * one person should not also throw away the way you were reading the table.
 */
function Filters({
  filters,
  query,
}: {
  filters: Route.ComponentProps["loaderData"]["filters"];
  query: HoldingsQuery;
}) {
  if (filters.length === 0) return null;

  const active = query.filters.size > 0;
  const cleared = toSearch({ ...query, filters: new Map() }) || ".";

  return (
    <Form method="get" className="filter-bar" aria-label="Filter holdings">
      {query.group !== null ? <input type="hidden" name="group" value={query.group} /> : null}
      {query.sort !== DEFAULT_SORT ? <input type="hidden" name="sort" value={query.sort} /> : null}
      {query.direction !== DEFAULT_DIRECTION ? (
        <input type="hidden" name="dir" value={query.direction} />
      ) : null}

      {filters.map((filter) => (
        <div key={filter.id}>
          <label htmlFor={`filter-${filter.id}`}>
            {filter.label}
            <select id={`filter-${filter.id}`} name={filter.id} defaultValue={filter.selected}>
              <option value="">All</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}

      <div className="filter-actions">
        <button type="submit" className="button">
          Apply
        </button>
        {active ? (
          <Link className="button button--text" to={cleared}>
            Clear filters
          </Link>
        ) : null}
      </div>
    </Form>
  );
}

/**
 * The group-by strip — anchors, not buttons, exactly as the range control on
 * Overview and Account detail is. `aria-current` carries the active state and
 * every chip preserves whatever filters and sort are already in force.
 */
function GroupBy({ query }: { query: HoldingsQuery }) {
  const chip = (id: DimensionId | null) => toSearch({ ...query, group: id });

  return (
    <nav className="segmented" aria-label="Group holdings by">
      <Link to={chip(null) === "" ? "." : chip(null)} aria-current={query.group === null ? "true" : undefined} preventScrollReset>
        No grouping
      </Link>
      {DIMENSIONS.map((dimension) => (
        <Link
          key={dimension.id}
          to={chip(dimension.id)}
          aria-current={query.group === dimension.id ? "true" : undefined}
          preventScrollReset
        >
          {dimension.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A column heading that sorts.
 *
 * `aria-sort` on the header is what tells a screen reader which column the
 * table is ordered by and in which direction — the caret beside the label says
 * the same thing to everyone else, and neither is left to carry it alone.
 */
function SortHeader({
  column,
  query,
}: {
  column: (typeof COLUMNS)[number];
  query: HoldingsQuery;
}) {
  const active = query.sort === column.key;
  const next: SortDirection = active
    ? query.direction === "asc"
      ? "desc"
      : "asc"
    : firstDirection(column.key);

  return (
    <th
      scope="col"
      role="columnheader"
      className={column.numeric ? "is-numeric" : undefined}
      aria-sort={active ? (query.direction === "asc" ? "ascending" : "descending") : undefined}
    >
      <Link
        className="sortable"
        to={toSearch({ ...query, sort: column.key, direction: next })}
        preventScrollReset
      >
        {column.label}
        <span className="sortable-caret" aria-hidden="true">
          {active ? (query.direction === "asc" ? "▲" : "▼") : ""}
        </span>
      </Link>
    </th>
  );
}

/**
 * A summed column, with what it was summed from written under it.
 *
 * The coverage goes here rather than only in the sentence below the table
 * because these three figures sit side by side and invite subtraction. A cost
 * basis over eleven holdings printed flush against a value over seventeen would
 * otherwise read as a $428,000 gain, which is not a figure anything in the
 * database supports. Where a column is complete it says nothing — a caption on
 * every cell would be noise, and the absence of one is the claim that there is
 * nothing missing.
 */
function Figures({ total }: { total: Total }) {
  // Nothing known at all is already said by the dash above; "0 of 1" beneath it
  // says it twice. The caption is for the partial case, which is the one a dash
  // cannot express.
  const note = (coverage: { known: number; total: number }) =>
    coverage.known === coverage.total || coverage.known === 0 ? null : (
      <span className="cell-sub u-data">
        {coverage.known} of {coverage.total}
      </span>
    );

  return (
    <>
      <td className="is-numeric" role="cell" data-label="Value">
        <Money amount={total.value} />
        {note(total.valueCoverage)}
      </td>
      <td className="is-numeric" role="cell" data-label="Cost basis">
        <Money amount={total.costBasis} />
        {note(total.basisCoverage)}
      </td>
      <td className="is-numeric" role="cell" data-label="Unrealized">
        {total.unrealized === null ? "—" : <Delta amount={total.unrealized} />}
        {note(total.unrealizedCoverage)}
      </td>
    </>
  );
}

/** One group: a heading row, its holdings, then its subtotal. */
function GroupBody({
  group,
  columns,
  span,
  labelSpan,
}: {
  group: Group;
  columns: ReadonlyArray<Column>;
  span: number;
  labelSpan: number;
}) {
  const count = group.total.valueCoverage.total;

  return (
    <tbody role="rowgroup">
      <tr className="row-group" role="row">
        <th scope="rowgroup" colSpan={span} role="rowheader">
          {group.label}
          <span className="cell-sub">
            {count} holding{count === 1 ? "" : "s"}
          </span>
        </th>
      </tr>

      {group.holdings.map((holding) => (
        <Row
          key={`${holding.accountId}-${holding.instrumentId}`}
          holding={holding}
          columns={columns}
        />
      ))}

      <tr className="row-subtotal" role="row">
        <th scope="row" colSpan={labelSpan} role="rowheader">
          {group.label} subtotal
          {/* "Of gross assets", not "of the total below". The denominator is
              the sum of the positive groups, so with a loan in the set these
              shares reach 100% above a `<tfoot role="rowgroup">` total that is smaller — see
              `allocation.ts` for why the net total is refused. A group nothing
              could price has no fraction to state at all. */}
          <span className="cell-sub">
            {group.share === null ? "—" : `${formatShare(group.share)} of gross assets`}
          </span>
        </th>
        <Figures total={group.total} />
      </tr>
    </tbody>
  );
}

function Row({ holding, columns }: { holding: Holding; columns: ReadonlyArray<Column> }) {
  const shows = (key: SortKey) => columns.some((column) => column.key === key);

  return (
    <tr role="row">
      <td role="cell" data-label="Asset">
        <div className="cell-stack">
          {holding.symbol ? <span className="badge">{holding.symbol}</span> : null}
          <div>
            {holding.instrumentName}
            <span className="cell-sub">
              {holding.classification} · {holdingNote(holding)}
            </span>
          </div>
        </div>
      </td>
      {shows("account") ? (
        <td role="cell" data-label="Account">
          {/* One hop to the account's own page, which is where its chart and its
              set-balance form live (§13.1). */}
          <Link className="cell-link" to={`/accounts/${holding.accountId}`}>
            {holding.accountName}
            <ChevronRightIcon />
          </Link>
          <span className="cell-sub">{holding.institution}</span>
        </td>
      ) : null}
      {shows("owner") ? <td role="cell" data-label="Owner">{holding.ownerName}</td> : null}
      <td className="is-numeric" role="cell" data-label="Quantity">
        {formatQuantity(holding.quantity)}
      </td>
      {/* Null price and null value are the same holding: never quoted. A dash
          says so; a zero would understate the portfolio by the whole position
          and look deliberate. */}
      <td className="is-numeric" role="cell" data-label="Price">
        <Money amount={holding.price} />
      </td>
      <td className="is-numeric" role="cell" data-label="Value">
        <Money amount={holding.value} />
      </td>
      <td className="is-numeric" role="cell" data-label="Cost basis">
        <Money amount={holding.costBasis} />
      </td>
      <td className="is-numeric" role="cell" data-label="Unrealized">
        {holding.unrealized === null ? "—" : <Delta amount={holding.unrealized} />}
      </td>
    </tr>
  );
}

/**
 * What the totals were computed from (§8.2's rule: sum what is known and label
 * the coverage).
 *
 * Three counts, not one, because they are genuinely three. A workplace plan
 * routinely reports a price and no cost basis at all, so the value total can be
 * complete while the unrealized total is short; and an instrument nobody can
 * quote is missing from the value total while its cost basis is on file. Saying
 * "40 of 42" once would have to pick one of those and misreport the others.
 */
function Coverage({ total, grouped }: { total: Total; grouped: boolean }) {
  const { valueCoverage: value, unrealizedCoverage: unrealized } = total;
  const notes: string[] = [];

  if (value.known < value.total) {
    const missing = value.total - value.known;
    notes.push(
      `Value is ${value.known} of ${value.total} holdings; ${missing} ${
        missing === 1 ? "has" : "have"
      } never been priced and ${missing === 1 ? "is" : "are"} left out rather than counted as zero.`,
    );
  } else {
    notes.push(`Value is all ${value.total} holdings.`);
  }

  if (unrealized.known < unrealized.total) {
    notes.push(
      `Unrealized is ${unrealized.known} of ${unrealized.total} — the rest have no cost basis recorded, and a missing cost basis is never read as zero.`,
    );
  }

  // The subtotals' shares are fractions of the gross positive total, not of the
  // figure in the Total row, and with a liability in the set the two differ
  // enough to matter. Named here once rather than repeated on every subtotal.
  if (grouped) {
    notes.push(
      "Each group's share is of gross assets — the positive groups added together — so the shares above sum to 100% and a liability's is negative.",
    );
  }

  return (
    <p className="coverage-note">
      {notes.join(" ")}
      {total.value !== null && isNegative(total.value)
        ? " The total is net of liabilities."
        : null}
    </p>
  );
}

