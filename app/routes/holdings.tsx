import { Form, Link, redirect } from "react-router";

import { AccountNumberTail } from "~/components/account-number-tail";
import { Amount, Delta } from "~/components/amount";
import { EmptyState } from "~/components/empty-state";
import {
  NarrowedTo,
  OwnerFilterControl,
  UNREADABLE_OWNER,
  holdsNothing,
} from "~/components/owner-filter-control";
import { ChevronRightIcon, EditIcon } from "~/components/icons";
import { isNegative, joinWords } from "~/lib/format";
import { formatShare } from "~/lib/allocation";
import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  DIMENSIONS,
  GROUPINGS,
  type DimensionId,
  type HoldingsQuery,
  type SortDirection,
  type SortKey,
  applyFilters,
  availableFilters,
  formatQuantity,
  groupHoldings,
  holdingNote,
  holdingYield,
  parseQuery,
  parseRowKey,
  rowKey,
  sortHoldings,
  summarise,
  toSearch,
} from "~/lib/holdings-view";
import { NotFoundError, ValidationError, formFields } from "~/lib/input.server";
import {
  ALL_OWNERS,
  isFiltered,
  readOwnerFilter,
  type OwnerFilter,
} from "~/lib/owner-filter";
import { isNarrowedToNothing, ownerReading } from "~/lib/owner-reading.server";
import { currentPosition, effectiveDate, revisePosition } from "~/lib/positions.server";
import { currentHoldings } from "~/lib/valuation.server";

import { PriceFreshness, type FreshnessView } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/holdings";

/** Every position across every account, grouped/filterable (DESIGN.md §8.1); view is the query string, `?edit=` opens a row. */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);

  // Grouped column is hidden — reset sort so the URL doesn't claim one with no caret/control.
  if (query.group !== null && !columnsFor(query.group).some((column) => column.key === query.sort)) {
    query.sort = DEFAULT_SORT;
    query.direction = DEFAULT_DIRECTION;
  }

  // `edit`/`saved` excluded from `HoldingsQuery`/`view` so filtering can't carry a half-typed correction; re-parsed, not echoed.
  const editing = parseRowKey(url.searchParams.get("edit"));
  const saved = parseRowKey(url.searchParams.get("saved"));

  // Owner filter is household-wide (ADR-0008). `toSearch` re-serializes, so `parseQuery(toSearch(q))` is `q` — a bounce cannot loop.
  const link = (owners: OwnerFilter) => toSearch(query, owners);
  const { reading, owner } = await ownerReading(request, {
    request: (owners) =>
      saved !== null
        ? withRow(link(owners), "saved", saved)
        : withRow(link(owners), "edit", editing),
    link,
  });
  const { owners } = owner;
  // Canonical view, no row open, no receipt — every Cancel goes here.
  const view = link(owners);

  const [household, freshness] = await Promise.all([
    currentHoldings(ALL_OWNERS),
    asOfView(getConfig().MARKET_TIMEZONE),
  ]);

  // Narrowed in SQL via the same predicate every screen reads through — not by filtering `household` here, a second implementation free to disagree.
  const holdings = isFiltered(owners) ? await currentHoldings(reading) : household;

  // Built from every holding, not the filtered set, or a vanished option would leave no way to widen back.
  const filters = availableFilters(household, query);
  const visible = applyFilters(holdings, query);

  // Receipt quotes the database, not the URL — figures come from `household` so a hand-typed id can't fabricate one.
  const open = saved === null ? editing : null;

  const written =
    saved === null
      ? null
      : (household.find(
          (holding) =>
            holding.accountId === saved.accountId && holding.instrumentId === saved.instrumentId,
        ) ?? null);

  return {
    freshness,
    ...owner,
    // Filter matched nothing vs. instance has nothing — told apart from this, not re-derived below.
    narrowedToNothing: isNarrowedToNothing(owners, {
      held: holdings.length,
      instance: household.length,
    }),
    // Counted over every holding, or the owner filter would make a full instance look empty.
    hasHoldings: household.length > 0,
    totalHoldings: household.length,
    accountCount: new Set(visible.map((holding) => holding.accountId)).size,
    filters,
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
    view,
    editing: open === null ? null : rowKey(open),
    // Read back from the database, not echoed from the submitted form.
    written:
      written === null
        ? null
        : {
            key: rowKey(written),
            instrumentName: written.instrumentName,
            accountName: written.accountName,
            quantity: written.quantity,
          },
    // Via `effectiveDate`, same as the write path — a statement can be dated tomorrow.
    asOf:
      open === null
        ? null
        : effectiveDate((await currentPosition(open.accountId, open.instrumentId))?.asOf ?? ""),
  };
}

/** Restates one position; positions.server.ts owns what lands (§5.4). Row id comes from the URL, not a hidden field submitted alongside it. */
export async function action({ request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const target = parseRowKey(url.searchParams.get("edit"));

  if (target === null) {
    // No form to re-render — a POST with no row named is a mangled address, not a bad figure.
    throw new Response("A correction has to name the row it corrects.", { status: 400 });
  }

  const values = formFields(await request.formData());

  try {
    await revisePosition(target.accountId, target.instrumentId, values);

    // Redirect, not render — reload can't resubmit; confirmation is forced to read the database.
    const view = toSearch(parseQuery(url.searchParams), readOwnerFilter(url.searchParams));
    throw redirect(`${url.pathname}${withRow(view, "saved", target)}`);
  } catch (error) {
    // URL still names the row, so this re-renders with the editor open and what was typed kept.
    if (error instanceof ValidationError) return { errors: error.fieldErrors, values };
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

const EDITOR = "revise-position";

// Canonical view plus one transient row (edit/saved) — kept out of `toSearch`, request-only, never part of a link built from the view.
function withRow(
  search: string,
  param: "edit" | "saved",
  row: { accountId: string; instrumentId: string } | null,
): string {
  if (row === null) return search;

  return `${search === "" ? "?" : `${search}&`}${param}=${rowKey(row)}`;
}

type Holding = NonNullable<Route.ComponentProps["loaderData"]["rows"]>[number];
type Total = Route.ComponentProps["loaderData"]["total"];
type Group = NonNullable<Route.ComponentProps["loaderData"]["groups"]>[number];

type Column = { key: SortKey; label: string; numeric: boolean };

const COLUMNS: ReadonlyArray<Column> = [
  { key: "asset", label: "Asset", numeric: false },
  { key: "account", label: "Account", numeric: false },
  { key: "owner", label: "Owner", numeric: false },
  { key: "quantity", label: "Quantity", numeric: true },
  { key: "price", label: "Price", numeric: true },
  { key: "value", label: "Value", numeric: true },
  { key: "costBasis", label: "Cost basis", numeric: true },
  { key: "unrealized", label: "Unrealized", numeric: true },
  // Last, not beside Value — Cost basis/Unrealized are a subtract-by-eye pair a projection would split.
  { key: "annualDividend", label: "Annual dividend", numeric: true },
];

const FIGURES = 4;

/** Owner/account grouping hides its own column — repeating the heading on every row wastes width. */
function columnsFor(group: DimensionId | null): ReadonlyArray<Column> {
  if (group === "owner") return COLUMNS.filter((column) => column.key !== "owner");
  if (group === "account") return COLUMNS.filter((column) => column.key !== "account");

  return COLUMNS;
}

/** First click: money columns sort desc (biggest first), names sort asc. */
function firstDirection(column: SortKey): SortDirection {
  return COLUMNS.find((entry) => entry.key === column)?.numeric === true ? "desc" : "asc";
}

export default function Holdings({ loaderData, actionData }: Route.ComponentProps) {
  const {
    roster,
    owners,
    narrowedTo,
    unknownOwner,
    showEveryone,
    narrowedToNothing,
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
    view,
    editing,
    written,
    asOf,
    freshness,
  } = loaderData;

  const query: HoldingsQuery = { filters: new Map(active), group, sort, direction };
  const shown = total.valueCoverage.total;
  // Owner filter counts as narrowing too (ADR-0008), or a narrowed table reads as the whole portfolio.
  const filtered = active.length > 0 || isFiltered(owners);
  const hidden = hiddenFields(query);

  // Gathered once, not threaded through `GroupBody` as six props it doesn't read.
  const editor: Editor = {
    editing,
    written,
    asOf,
    view,
    errors: actionData?.errors,
    values: actionData?.values,
  };

  // Clears only this screen's filters, not grouping/sort; owner filter is separate — "Show everyone" is its own control.
  const cleared = toSearch({ ...query, filters: new Map() }, owners) || ".";
  const columns = columnsFor(group);
  // +1 for the row's Edit control — no `SortKey`, so not a `Column`.
  const span = columns.length + 1;
  const labelSpan = columns.length - FIGURES;

  // Only state claiming "nothing uploaded" — an owner filter reaching nothing is handled below instead.
  if (!hasHoldings) {
    return (
      <section className="page">
        <Header freshness={freshness} roster={roster} owners={owners} hidden={hidden} />
        <EmptyState>
          Every position across every account will be listed here, grouped and filterable.
          Nothing has been uploaded to this instance yet.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page">
      <Header freshness={freshness} roster={roster} owners={owners} hidden={hidden} />

      <Filters filters={filters} query={query} owners={owners} />
      <GroupBy query={query} owners={owners} />

      <div className="panel">
        <header className="panel-header">
          <h2 className="panel-title">{group === null ? "All holdings" : groupTitle(group)}</h2>
          <p className="panel-count u-data">
            {shown} holding{shown === 1 ? "" : "s"} · {accountCount} account
            {accountCount === 1 ? "" : "s"}
            {/* Without this a filtered table looks like the whole portfolio. */}
            {filtered ? ` · filtered from ${totalHoldings}` : null}
          </p>
          <NarrowedTo owners={narrowedTo} />
        </header>

        {shown === 0 ? (
          // Not the empty state above — the instance has data, this filter just matches nothing.
          <div className="panel-body panel-body--empty">
            <p className="empty-note">
              {describe({ filters, narrowedTo, unknownOwner, narrowedToNothing })}{" "}
              <span className="u-data">{totalHoldings}</span>{" "}
              {totalHoldings === 1 ? "holding is" : "holdings are"} recorded in all.
            </p>
            {active.length > 0 ? (
              <Link className="button button--text" to={cleared}>
                Clear filters
              </Link>
            ) : null}
            {/* Owner filter is household-wide, not this screen's — link names everyone rather than "clear". */}
            {isFiltered(owners) ? (
              <Link className="button button--text" to={showEveryone}>
                Show everyone
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <div className="data-table-scroll">
              {/* Explicit roles: below 768px this table reflows to cards and browsers drop the implicit ARIA roles. */}
                <table className="data-table data-table--holdings" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    {columns.map((column) => (
                      <SortHeader key={column.key} column={column} query={query} owners={owners} />
                    ))}
                    {/* Named for a screen reader only — an icon column needs no visible label. */}
                    <th scope="col" role="columnheader" className="is-actions">
                      <span className="visually-hidden">Correct</span>
                    </th>
                  </tr>
                </thead>

                {groups === null ? (
                  <tbody role="rowgroup">
                    {rows?.map((holding) => (
                      <Row
                        key={`${holding.accountId}-${holding.instrumentId}`}
                        holding={holding}
                        columns={columns}
                        span={span}
                        editor={editor}
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
                      editor={editor}
                    />
                  ))
                )}

                <tfoot role="rowgroup">
                  <tr className="row-total" role="row">
                    <th scope="row" colSpan={labelSpan} role="rowheader">
                      Total
                    </th>
                    <Figures total={total} />
                    <td className="is-actions" role="cell" />
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

/** Why the table is empty, in words — owner filter takes precedence over this screen's own selects. */
function describe({
  filters,
  narrowedTo,
  unknownOwner,
  narrowedToNothing,
}: {
  filters: Route.ComponentProps["loaderData"]["filters"];
  narrowedTo: Route.ComponentProps["loaderData"]["narrowedTo"];
  unknownOwner: boolean;
  narrowedToNothing: boolean;
}): string {
  if (unknownOwner) return UNREADABLE_OWNER;

  const holds = holdsNothing(narrowedTo);

  if (narrowedToNothing) return `${holds} nothing that has been recorded here.`;

  const chosen = filters
    .map((filter) => filter.selectedPhrase)
    .filter((phrase): phrase is string => phrase !== null);

  if (narrowedTo.length > 0 && chosen.length > 0) {
    return `${holds} nothing ${joinWords(chosen)}.`;
  }

  const absent = filters.filter((filter) => filter.selectedIsAbsent);

  if (absent.length > 0) {
    const named = joinWords(absent.map((filter) => filter.label.toLowerCase()));

    return `The ${named} filter names something this portfolio does not hold — the link may predate a change to it.`;
  }

  if (chosen.length === 0) return "Nothing is held at all.";
  if (chosen.length === 1) return `Nothing in the portfolio is ${chosen[0]}.`;

  return `No holding matches every filter at once. Nothing in the portfolio is ${joinWords(chosen)}.`;
}

function Header({
  freshness,
  roster,
  owners,
  hidden,
}: {
  freshness: FreshnessView;
  roster: Route.ComponentProps["loaderData"]["roster"];
  owners: OwnerFilter;
  hidden: Record<string, string>;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">Holdings</h1>
        <p className="page-subtitle">
          Every position the household holds, whichever account it sits in.
        </p>
      </div>

      <div className="page-actions">
        <OwnerFilterControl owners={roster} selected={owners} hidden={hidden} />
        <PriceFreshness freshness={freshness} />
      </div>
    </header>
  );
}

// Hidden fields for the owner control — a GET form submits only its own, else switching owner drops sort/grouping/filters.
function hiddenFields(query: HoldingsQuery): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const dimension of DIMENSIONS) {
    const value = query.filters.get(dimension.id);
    if (value !== undefined) fields[dimension.id] = value;
  }

  if (query.group !== null) fields.group = query.group;
  if (query.sort !== DEFAULT_SORT) fields.sort = query.sort;
  if (query.direction !== DEFAULT_DIRECTION) fields.dir = query.direction;

  return fields;
}

function groupTitle(group: DimensionId): string {
  return `Grouped by ${(GROUPINGS.find((dimension) => dimension.id === group)?.label ?? group).toLowerCase()}`;
}

/** Filter bar as a plain GET form — no JavaScript needed; grouping/sort ride along as hidden fields. */
function Filters({
  filters,
  query,
  owners,
}: {
  filters: Route.ComponentProps["loaderData"]["filters"];
  query: HoldingsQuery;
  owners: OwnerFilter;
}) {
  if (filters.length === 0) return null;

  const active = query.filters.size > 0;
  // Owner filter stands — household-wide, cleared via its own control.
  const cleared = toSearch({ ...query, filters: new Map() }, owners) || ".";

  return (
    <Form method="get" className="filter-bar" aria-label="Filter holdings">
      {/* Owner filter travels with every control, one field per id, matching the owner control's own checkboxes. */}
      {owners.map((owner) => (
        <input key={owner} type="hidden" name="owner" value={owner} />
      ))}
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

/** Group-by strip: anchors with `aria-current`; visible caption doubles as accessible name via `aria-labelledby`. */
function GroupBy({ query, owners }: { query: HoldingsQuery; owners: OwnerFilter }) {
  const chip = (id: DimensionId | null) => toSearch({ ...query, group: id }, owners);

  return (
    <div className="segmented-group">
      <span className="u-label" id="group-by">
        Group by
      </span>
      <nav className="segmented" aria-labelledby="group-by">
        <Link to={chip(null) === "" ? "." : chip(null)} aria-current={query.group === null ? "true" : undefined} preventScrollReset>
          No grouping
        </Link>
        {GROUPINGS.map((dimension) => (
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
    </div>
  );
}

/** Sortable column heading — `aria-sort` for screen readers, caret for everyone else. */
function SortHeader({
  column,
  query,
  owners,
}: {
  column: (typeof COLUMNS)[number];
  query: HoldingsQuery;
  owners: OwnerFilter;
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
        to={toSearch({ ...query, sort: column.key, direction: next }, owners)}
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

/** Summed column with its coverage caption beneath — side-by-side figures invite subtraction, so a partial column must say so. */
function Figures({ total }: { total: Total }) {
  // Full or zero coverage is already said elsewhere; caption is only for the partial case.
  const note = (coverage: { known: number; total: number }) =>
    coverage.known === coverage.total || coverage.known === 0 ? null : (
      <span className="cell-sub u-data">
        {coverage.known} of {coverage.total}
      </span>
    );

  // Figure and caption share a wrapper: below 768px this becomes a flex row and needs two items, not three, to stay right-aligned (§7.3).
  return (
    <>
      <td className="is-numeric" role="cell" data-label="Value">
        <div>
          <Amount value={total.value} />
          {note(total.valueCoverage)}
        </div>
      </td>
      <td className="is-numeric" role="cell" data-label="Cost basis">
        <div>
          <Amount value={total.costBasis} />
          {note(total.basisCoverage)}
        </div>
      </td>
      <td className="is-numeric" role="cell" data-label="Unrealized">
        <div>
          {total.unrealized === null ? "—" : <Delta amount={total.unrealized} />}
          {note(total.unrealizedCoverage)}
        </div>
      </td>
      {/* No caption: rate coalesces to zero, complete by construction. No weighted yield either — that's Income's figure to show. */}
      <td className="is-numeric" role="cell" data-label="Annual dividend">
        <Amount value={total.annualDividend} />
      </td>
    </>
  );
}

function GroupBody({
  group,
  columns,
  span,
  labelSpan,
  editor,
}: {
  group: Group;
  columns: ReadonlyArray<Column>;
  span: number;
  labelSpan: number;
  editor: Editor;
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
          span={span}
          editor={editor}
        />
      ))}

      <tr className="row-subtotal" role="row">
        <th scope="row" colSpan={labelSpan} role="rowheader">
          {group.label} subtotal
          {/* Denominator is the positive groups' sum, not the total below — a liability would push shares past 100% (allocation.ts). */}
          <span className="cell-sub">
            {group.share === null ? "—" : `${formatShare(group.share)} of gross assets`}
          </span>
        </th>
        <Figures total={group.total} />
        <td className="is-actions" role="cell" />
      </tr>
    </tbody>
  );
}

/** State for the one row (if any) under correction. */
type Editor = {
  editing: string | null;
  written: Route.ComponentProps["loaderData"]["written"];
  asOf: string | null;
  view: string;
  errors?: Readonly<Record<string, string>>;
  values?: Record<string, string>;
};

/** One holding, with (at most one at a time) its inline correction (§5.4); inputs sit in a row beneath, joined by `form=` since a `<form>` can't wrap a `<tr>`. */
function Row({
  holding,
  columns,
  span,
  editor,
}: {
  holding: Holding;
  columns: ReadonlyArray<Column>;
  span: number;
  editor: Editor;
}) {
  const shows = (key: SortKey) => columns.some((column) => column.key === key);
  const key = rowKey(holding);
  const open = editor.editing === key;
  const { errors, values } = editor;

  // Collected here, not per-box — a message in a narrow column would wrap or shift figures.
  const messages =
    errors === undefined
      ? []
      : (["form", "quantity", "costBasisPerShare"] as const)
          .map((field) => [field, errors[field]] as const)
          .filter((entry): entry is readonly [(typeof entry)[0], string] => entry[1] !== undefined);

  // Typed value wins over stored, so a refusal never costs the entry.
  const typedQuantity = values?.quantity ?? formatQuantity(holding.quantity);
  const typedBasis =
    values?.costBasisPerShare ??
    (holding.costBasisPerShare === null ? "" : formatQuantity(holding.costBasisPerShare));

  // Null, not 0%: unpriceable or zero-value holding would otherwise divide by zero.
  const yieldOnValue = holdingYield(holding);

  return (
    <>
      <tr role="row" className={open ? "row-editing" : undefined}>
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
            <Link className="cell-link" to={`/accounts/${holding.accountId}`}>
              {holding.accountName}
              <AccountNumberTail tail={holding.accountNumberTail} />
              <ChevronRightIcon />
            </Link>
            <span className="cell-sub">{holding.institution}</span>
          </td>
        ) : null}
        {shows("owner") ? <td role="cell" data-label="Owner">{holding.ownerName}</td> : null}
        <td className="is-numeric" role="cell" data-label="Quantity">
          {open ? (
            <input
              id="revise-quantity"
              form={EDITOR}
              name="quantity"
              defaultValue={typedQuantity}
              // `text`, not `number` — a number input silently drops unparseable paste ("1,250.00").
              type="text"
              inputMode="decimal"
              className="cell-input"
              aria-label={`Quantity of ${holding.instrumentName}`}
              aria-invalid={errors?.quantity ? true : undefined}
              aria-describedby={errors?.quantity ? "revise-error-quantity" : undefined}
              autoComplete="off"
              autoFocus
            />
          ) : (
            <Amount value={holding.quantity} shape="quantity" />
          )}
        </td>
        <td className="is-numeric" role="cell" data-label="Price">
          <Amount value={holding.price} />
        </td>
        <td className="is-numeric" role="cell" data-label="Value">
          <Amount value={holding.value} />
        </td>
        <td className="is-numeric" role="cell" data-label="Cost basis">
          {open ? (
            <input
              id="revise-cost-basis"
              form={EDITOR}
              name="costBasisPerShare"
              defaultValue={typedBasis}
              type="text"
              inputMode="decimal"
              className="cell-input"
              // Column shows whole-position basis, this box per-share — stated in the label since they won't match.
              aria-label={`Cost basis per share of ${holding.instrumentName}`}
              placeholder="per share"
              aria-invalid={errors?.costBasisPerShare ? true : undefined}
              aria-describedby={
                errors?.costBasisPerShare ? "revise-error-costBasisPerShare" : undefined
              }
              autoComplete="off"
            />
          ) : (
            <Amount value={holding.costBasis} />
          )}
        </td>
        <td className="is-numeric" role="cell" data-label="Unrealized">
          {holding.unrealized === null ? "—" : <Delta amount={holding.unrealized} />}
        </td>
        {/* $0, not a dash: `quote` can't tell "pays nothing" from "nobody asked" (§14 limitation 9). Plain `Amount`, not `Delta` — a payout isn't a movement. */}
        <td className="is-numeric" role="cell" data-label="Annual dividend">
          <div>
            <Amount value={holding.annualDividend} />
            {yieldOnValue === null ? null : (
              <span className="cell-sub u-data">{formatShare(yieldOnValue)}</span>
            )}
          </div>
        </td>
        <td className="is-actions" role="cell" data-label="">
          {open ? null : (
            <Link
              className="row-edit"
              to={withRow(editor.view, "edit", holding)}
              aria-label={`Correct ${holding.instrumentName} in ${holding.accountName}`}
              preventScrollReset
            >
              <EditIcon />
            </Link>
          )}
        </td>
      </tr>

      {open ? (
        // Save/Cancel live here, not the actions cell — that's `width: 1%`, too narrow for two buttons.
        <tr className="row-note" role="row">
          <td colSpan={span} role="cell" data-label="">
            <div className="row-editor">
              <div>
                {messages.length > 0 ? (
                  messages.map(([field, message]) => (
                    <p
                      key={field}
                      id={`revise-error-${field}`}
                      className="field-error"
                      role="alert"
                    >
                      {message}
                    </p>
                  ))
                ) : (
                  // Said before the click — "Save" files a whole new statement, not a single overwrite.
                  <p className="form-note">
                    Saving records a new statement for {holding.accountName}
                    {editor.asOf === null ? null : <>, dated {editor.asOf},</>} carrying every
                    other position in it forward unchanged. The current one is kept on its own
                    date, so nothing already recorded moves.
                  </p>
                )}
              </div>

              <Form
                id={EDITOR}
                method="post"
                action={`/holdings${withRow(editor.view, "edit", holding)}`}
                className="row-actions"
              >
                <button type="submit" className="button button--quiet">
                  Save
                </button>
                <Link className="button button--text" to={editor.view === "" ? "." : editor.view}>
                  Cancel
                </Link>
              </Form>
            </div>
          </td>
        </tr>
      ) : null}

      {editor.written?.key === key ? (
        <tr className="row-note" role="row">
          <td colSpan={span} role="cell" data-label="">
            <p className="form-note" role="status">
              Recorded. {editor.written.accountName} now reads{" "}
              <b className="u-data">
                <Amount value={editor.written.quantity} shape="quantity" />
              </b>{" "}
              of{" "}
              {editor.written.instrumentName}.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** What the totals were computed from (§8.2) — three separate counts, since a workplace plan has a price but no cost basis and an unquotable one is the reverse. */
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

  // Fractions of gross assets, not the Total row — stated once, not per subtotal.
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
