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

/**
 * Holdings — every position across every account, grouped and filterable.
 * DESIGN.md §8.1's workhorse: "a groupable, filterable Holdings table
 * absorbs what would otherwise be four more pages... the same table with
 * the grouping changed, not separate features."
 *
 * The whole screen is one query and one array: `currentHoldings` returns
 * the rows; `holdings-view.ts` filters, sorts, groups and totals them with
 * no second database touch, because every dimension is already a column on
 * the row (§8.2) — so nothing here can disagree with Overview or Account
 * detail, and no subtotal can disagree with the rows printed above it.
 *
 * **No client-side state.** Every control is a link or a GET form and the
 * view is entirely the query string (Overview's range-control arrangement):
 * works with JavaScript off, survives a reload, can be bookmarked or sent.
 * That rule also shapes the one write here (§5.4): "editable cells" is a
 * `useState` per row and any figure one mis-click from overwritten;
 * `?edit=12.7` is a link that opens exactly one row — the screen's existing
 * grammar applied to a form, not a new mechanism bolted beside it.
 */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);

  // Grouping hides the column it grouped by, so a URL sorting by that column
  // would leave the table ordered by a heading nobody can see — no caret, no
  // `aria-sort`, no control to reverse it. Fall back here, not in the
  // component, so the URL stops claiming a sort the screen is not applying.
  if (query.group !== null && !columnsFor(query.group).some((column) => column.key === query.sort)) {
    query.sort = DEFAULT_SORT;
    query.direction = DEFAULT_DIRECTION;
  }

  // `edit` and `saved` are deliberately *not* part of `HoldingsQuery`: they
  // are one thing being done to one row, not how the table is read, and
  // keeping them out is what closes the editor for free on every control —
  // each is a link built by `toSearch`, which knows neither parameter and
  // drops both. Filtering while a row is open must not carry a half-typed
  // correction into a different view. Still canonicalised, by re-serialising
  // the parsed pair rather than echoing: a mangled `edit=` bounces to the
  // URL without it — the same "no editor" a missing one produces.
  const editing = parseRowKey(url.searchParams.get("edit"));
  const saved = parseRowKey(url.searchParams.get("saved"));

  // The owner filter is household-wide, not one of `query`'s own dimensions
  // (ADR-0008), but `edit`/`saved` are this screen's own request-only state —
  // a bounce must not close an editor the reader had open, and no link built
  // from the view (`link`, below) may carry either. `withRow` and `columnsFor`
  // are hoisted function declarations, legal to reach for from this closure.
  //
  // `toSearch` is this screen's own canonical spelling, not the module's
  // default: a GET form submits every control it holds, touched or not, so
  // Apply with one filter arrives as `?owner=1&account=&institution=&kind=&…`
  // — unreadable in a bookmark — and the bounce cleans it in one hop. And its
  // own bounce cannot loop, the half `owner-reading.server.ts`'s own comment
  // does not cover (`toOwnerParam`'s fixed-point property, which `toSearch`
  // composes with, is the shared half): `parseQuery(toSearch(q))` is `q`, so
  // the respelled `url.search` is a fixed point of this screen's own grammar,
  // not only of the owner parameter alone.
  const link = (owners: OwnerFilter) => toSearch(query, owners);
  const { reading, owner } = await ownerReading(request, {
    request: (owners) =>
      saved !== null
        ? withRow(link(owners), "saved", saved)
        : withRow(link(owners), "edit", editing),
    link,
  });
  const { owners } = owner;
  /** The canonical view, with no row open and no receipt — every Cancel goes here. */
  const view = link(owners);

  const [household, freshness] = await Promise.all([
    currentHoldings(ALL_OWNERS),
    asOfView(getConfig().MARKET_TIMEZONE),
  ]);

  // Narrowed in SQL, through the same predicate every other screen reads
  // through, rather than by filtering `household` here — which would be a
  // second implementation of one rule, free to disagree with the first about
  // an id no person carries. A second round trip, and only while narrowed.
  const holdings = isFiltered(owners) ? await currentHoldings(reading) : household;

  // The filter controls are built from *every* holding, not from the filtered
  // set: options that vanished as you narrowed would leave no way to widen
  // again. That now includes narrowing by owner, so they are built from
  // `household` rather than from what the owner filter left.
  const filters = availableFilters(household, query);
  const visible = applyFilters(holdings, query);

  // The receipt quotes the database, never the URL: `?saved=` says *which*
  // row was written, and the figures beside the confirmation are read back
  // out of the household read — so a hand-typed parameter can only produce a
  // sentence describing what the account actually holds (Account detail's
  // `?recorded=` guarantee, §13.7). Looked up in every holding, not the
  // filtered set, so the sentence survives a narrowed view.
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
    // Empty because the filter reached nothing, rather than because the
    // instance has nothing — the sentence below is written from this rather
    // than derived a second time, so the three states are told apart in one
    // place.
    narrowedToNothing: isNarrowedToNothing(owners, {
      held: holdings.length,
      instance: household.length,
    }),
    // Distinguishes "nothing uploaded" from "this filter matched nothing" —
    // two states that must not share a screen (§8.4). Both counted over every
    // holding rather than over the narrowed set, or the owner filter would
    // make an instance full of data look like an empty one.
    hasHoldings: household.length > 0,
    totalHoldings: household.length,
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
    view,
    /** The row the editor is open on, or null. */
    editing: open === null ? null : rowKey(open),
    /** The row just written, as the database now reads it. */
    written:
      written === null
        ? null
        : {
            key: rowKey(written),
            instrumentName: written.instrumentName,
            accountName: written.accountName,
            quantity: written.quantity,
          },
    /**
     * The date the open row's correction will be filed under — from the
     * server, through the same {@link effectiveDate} the write uses: a
     * statement may legitimately be dated tomorrow, and a correction against
     * it carries that date, so a note promising "dated today" would be the
     * screen misreporting its own effect. One extra query, only while a row
     * is open.
     */
    asOf:
      open === null
        ? null
        : effectiveDate((await currentPosition(open.accountId, open.instrumentId))?.asOf ?? ""),
  };
}

/**
 * Restate one position. The route reads two boxes and hands them over;
 * everything deciding whether and what lands is `positions.server.ts`
 * (§5.4). **Which row is corrected comes from the URL, not a hidden
 * field**: the form posts back to the address that opened it, so the row's
 * identity travels as the rest of this screen's state does and no field can
 * disagree with the page it was submitted from. The redirect target is
 * rebuilt by `toSearch` from a parsed query, never echoed — the only
 * strings it can produce are ones this screen already speaks.
 */
export async function action({ request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const target = parseRowKey(url.searchParams.get("edit"));

  if (target === null) {
    // Not a validation failure: there is no form to re-render a message on. A
    // POST here without a row named is a mangled address, not a bad figure.
    throw new Response("A correction has to name the row it corrects.", { status: 400 });
  }

  const values = formFields(await request.formData());

  try {
    await revisePosition(target.accountId, target.instrumentId, values);

    // Redirect rather than render, for Account detail's three reasons: a
    // reload cannot re-submit, the boxes are gone (a fresh GET), and the
    // confirmation is forced to describe what the database says. The owner
    // filter comes off the same URL the row's identity does, so the
    // correction returns to the narrowed view.
    const view = toSearch(parseQuery(url.searchParams), readOwnerFilter(url.searchParams));
    throw redirect(`${url.pathname}${withRow(view, "saved", target)}`);
  } catch (error) {
    // The URL still names the row, so the editor is still open when this
    // re-renders — which is what lets the message appear beside the box that
    // caused it while the box keeps what was typed.
    if (error instanceof ValidationError) return { errors: error.fieldErrors, values };
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

/** The form the row's inputs belong to — see {@link Row} for why they are apart. */
const EDITOR = "revise-position";

/**
 * A canonical view, plus the one transient row a receipt or an editor names.
 *
 * Appended here rather than taught to `toSearch`, because the parameter is
 * transient by design: it belongs to this request and to no link built from the
 * view (see the loader).
 */
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
  // Last, after Unrealized, rather than beside Value where it is most often
  // read. `Cost basis` and `Unrealized` are a pair — what you paid, what you
  // gained — and a forward projection wedged between them would break the one
  // subtraction in the row a reader is meant to be able to do by eye.
  { key: "annualDividend", label: "Annual dividend", numeric: true },
];

/** The four money columns a subtotal and the grand total have figures for. */
const FIGURES = 4;

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
  // The owner filter counts here as much as this screen's own: without it a
  // table narrowed to one person reads as the whole portfolio to anyone who
  // did not set the filter — the honesty condition ADR-0008 attaches to the
  // filter surviving navigation, kept in the notice below.
  const filtered = active.length > 0 || isFiltered(owners);
  const hidden = hiddenFields(query);

  // Everything one row needs to know about being the row that is open, gathered
  // once rather than threaded through `GroupBody` as six props it does not read.
  const editor: Editor = {
    editing,
    written,
    asOf,
    view,
    errors: actionData?.errors,
    values: actionData?.values,
  };

  // Clearing the filters clears the filters: grouping and sort are how you
  // were reading the table, not what — a "Clear" that threw them away would
  // undo more than it says. The owner filter is not this screen's to clear
  // either, for a stronger reason: household-wide, so clearing it here would
  // change what Overview shows next. "Show everyone" lives on the owner
  // control, where the reader set it.
  const cleared = toSearch({ ...query, filters: new Map() }, owners) || ".";
  const columns = columnsFor(group);
  // One column past the data columns: the row's Edit control. It sorts by
  // nothing and sums to nothing, so it is not a `Column` — an entry with no
  // `SortKey` would need special-casing in headers, sort links and
  // `columnsFor` alike.
  const span = columns.length + 1;
  const labelSpan = columns.length - FIGURES;

  // The one state that may say nothing has been uploaded, because it is the
  // only one where nothing has been. An owner filter reaching no holdings is
  // an instance full of data this reading does not reach; it falls through
  // to the panel below, where "the question's answer is nothing" has always
  // been drawn.
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
            {/* Without this a filtered table looks like the whole portfolio to
                anyone who did not set the filter — including you, a day later,
                following your own bookmark. */}
            {filtered ? ` · filtered from ${totalHoldings}` : null}
          </p>
          <NarrowedTo owners={narrowedTo} />
        </header>

        {shown === 0 ? (
          // Not the empty state above: the instance has data; this question
          // has no answer, and "there is no data yet" would be a false claim.
          // Three questions now — this screen's filters, an owner naming
          // nobody, owners holding nothing — each with its own sentence and
          // way out.
          <div className="panel-body panel-body--empty">
            <p className="empty-note">
              {describe({ filters, narrowedTo, unknownOwner, narrowedToNothing })}{" "}
              <span className="u-data">{totalHoldings}</span>{" "}
              {totalHoldings === 1 ? "holding is" : "holdings are"} recorded in all.
            </p>
            {/* The `.button--text` §7.2 names, not an inline link: the bar
                above already draws "Clear filters" as a text button, and the
                same words at the same URL as an underlined inline link were
                two different components 280px apart. */}
            {active.length > 0 ? (
              <Link className="button button--text" to={cleared}>
                Clear filters
              </Link>
            ) : null}
            {/* Its own way out: the owner filter is household-wide, not this
                screen's to clear, and the link says so by naming everyone
                rather than saying "clear". */}
            {isFiltered(owners) ? (
              <Link className="button button--text" to={showEveryone}>
                Show everyone
              </Link>
            ) : null}
          </div>
        ) : (
          <>
            <div className="data-table-scroll">
              {/* Explicit roles, matching the implicit ones exactly: below
                    768px the stylesheet reflows this table to cards with
                    `display: block`, and browsers then drop the implicit ARIA
                    roles — `scope`, `aria-sort`, every header-to-cell
                    association — leaving a screen reader a pile of unlabelled
                    text. Spelling them out costs nothing on desktop. */}
                <table className="data-table data-table--holdings" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    {columns.map((column) => (
                      <SortHeader key={column.key} column={column} query={query} owners={owners} />
                    ))}
                    {/* Named for a screen reader, blank for everyone else: a
                        word over a column of icons would head a control, not
                        data — and on the phone it would read as one more sort
                        link. */}
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

/**
 * Why the table is empty, in words — "Nothing in the portfolio is at Chase
 * and in a bank account." Saying only "no holding matches every filter"
 * leaves the reader working out which pair of six dropdowns cannot coexist;
 * the controls know their chosen options, so the screen names them. The
 * stale-key case gets its own words: a filter pointing at a since-closed
 * account is a fact about the URL, not the portfolio. The owner filter adds
 * two more answers and takes precedence, in the order they stop being the
 * reader's problem: an unreadable owner is a fact about the address, an
 * owner holding nothing a fact about the household, and only then an
 * overlap of this screen's own selects. With both on, the sentence must say
 * *whose* portfolio holds nothing — the selects are built from every
 * holding, so "nothing in the portfolio is in Bob Roth" would be a plain
 * falsehood on a table narrowed to Alice.
 */
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
  // The owner filter first — the more fundamental fact: if the household
  // cannot be read as these people, or they hold nothing, the selects are
  // beside the point.
  if (unknownOwner) return UNREADABLE_OWNER;

  const holds = holdsNothing(narrowedTo);

  if (narrowedToNothing) return `${holds} nothing that has been recorded here.`;

  const chosen = filters
    .map((filter) => filter.selectedPhrase)
    .filter((phrase): phrase is string => phrase !== null);

  // Narrowed *and* filtered: the sentence names whose portfolio it is
  // talking about (the doc above has why).
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

/**
 * This screen's own state, for the owner control's hidden fields: a GET
 * form submits its own fields and nothing else, so changing the owner would
 * otherwise reset the sort, grouping and every dimension filter. Defaults
 * left out, for `toSearch`'s reason. `edit` and `saved` are not here and
 * must never be — narrowing while a row is open must not carry a half-typed
 * correction into a different view (the loader's rule).
 */
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

/**
 * The filter bar — a plain GET form: the selects write the query string the
 * loader already reads, so no JavaScript and the view is a URL. Grouping
 * and sort ride along as hidden fields: narrowing should not also throw
 * away the way you were reading the table.
 */
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
  // Clears this screen's own filters and leaves the owner filter standing: it
  // is household-wide, and "show everyone" belongs on the control that set it.
  const cleared = toSearch({ ...query, filters: new Map() }, owners) || ".";

  return (
    <Form method="get" className="filter-bar" aria-label="Filter holdings">
      {/* The owner filter travels with every control here, or picking an
          account type would silently widen the table to the household. One
          field per id, as the owner control's checkboxes submit — a
          comma-joined string would be a fourth place spelling a grammar
          `toOwnerParam` exists to be the only speller of. */}
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

/**
 * The group-by strip — anchors, not buttons, as the range control is;
 * `aria-current` carries the active state and every chip preserves the
 * filters and sort in force. The visible caption doubles as the strip's
 * accessible name via `aria-labelledby`: with a separate name, a screen
 * reader had "Group holdings by" while everyone else had eight chips and
 * nothing saying what they group — and one name cannot drift from itself.
 */
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

/**
 * A column heading that sorts. `aria-sort` tells a screen reader which
 * column orders the table and which way; the caret says the same to
 * everyone else, and neither is left to carry it alone.
 */
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

/**
 * A summed column, with what it was summed from written under it — here,
 * not only in the sentence below the table, because these figures sit side
 * by side and invite subtraction: a cost basis over eleven holdings flush
 * against a value over seventeen reads as a $428,000 gain nothing in the
 * database supports. A complete column says nothing — the absence of a
 * caption is the claim that nothing is missing.
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

  // A figure and its caption share a wrapper (the annual-dividend cell's
  // shape) — below 768px the cell becomes a flex label-and-figure row, and
  // `space-between` over three bare items (label, figure, caption) parked
  // the money mid-card, off the right edge every other figure shared.
  // Wrapped, it hands over two items whatever the coverage, and `.cell-sub`'s
  // `display: block` puts the count back beneath its figure (§7.3).
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
      {/* No caption — the view coalesces a missing rate to zero, so this
          column is complete by construction and "4 of 4" would be noise.
          No weighted yield either: the ratio under a row is that row's own;
          the same ratio over a subtotal is a *weighted* yield — a different
          figure with its own undefined cases, and Income's to show. Printed
          here in the row percentages' typeface, the two would read as the
          same number. */}
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
          {/* "Of gross assets", not "of the total below": the denominator is
              the positive groups' sum, so with a loan in the set the shares
              reach 100% above a smaller total (`allocation.ts` has why the
              net total is refused). A group nothing could price has no
              fraction to state. */}
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

/** What a row needs to know about the one correction the screen may be making. */
type Editor = {
  /** The row key the editor is open on, or null. */
  editing: string | null;
  /** The row a write just landed on, as the loader read it back. */
  written: Route.ComponentProps["loaderData"]["written"];
  /** The date the open row's correction will carry, or null with none open. */
  asOf: string | null;
  /** The canonical view with no row named — where Cancel goes. */
  view: string;
  errors?: Readonly<Record<string, string>>;
  values?: Record<string, string>;
};

/**
 * One holding, and — for at most one at a time — the boxes that correct it
 * (§5.4).
 *
 * **Inputs in their own columns, form in the row beneath**: a `<form>`
 * cannot wrap a `<tr>`, and a single-cell editor would take the quantity
 * out of its column's right-aligned tabular figures — most of what makes an
 * inline correction readable. The form sits in the full-width row below and
 * the inputs join it by `form=`.
 *
 * **Price, Value and Unrealized keep showing the stored figures while a row
 * is open** — they are what the correction is made against; blanking or
 * projecting them from the half-typed quantity would replace the reference
 * with a guess at the moment it is read. The boxes open on
 * `formatQuantity`'s output, not the raw column (`120.5`, never
 * `120.50000000`) — `signedQuantity` and `perShareAmount` take that
 * spelling back, U+2212 and separators and all, so prefill and parser are
 * the same string.
 */
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

  // Every refusal, in a fixed order, gathered for the line beneath the row —
  // not under each box, because the boxes are in table columns: a refusal is
  // a sentence, and a sentence in a 6rem column either wraps to five lines
  // or shifts every figure sideways, at the moment it is being read. The
  // full-width line has room; `aria-invalid`/`aria-describedby` keep each
  // message attached to its box for a reader not looking at the layout.
  const messages =
    errors === undefined
      ? []
      : (["form", "quantity", "costBasisPerShare"] as const)
          .map((field) => [field, errors[field]] as const)
          .filter((entry): entry is readonly [(typeof entry)[0], string] => entry[1] !== undefined);

  // What was typed wins over what is stored, so a refusal never costs the
  // entry. On a fresh open there is nothing typed and the stored figures are
  // what the boxes show.
  const typedQuantity = values?.quantity ?? formatQuantity(holding.quantity);
  const typedBasis =
    values?.costBasisPerShare ??
    (holding.costBasisPerShare === null ? "" : formatQuantity(holding.costBasisPerShare));

  // Null where there is no percentage to state rather than a percentage of
  // zero: a holding nobody can price, and one whose value has gone to zero —
  // which would otherwise be divided by. See `holdingYield`.
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
            {/* One hop to the account's own page, which is where its chart and its
                set-balance form live (§13.1). */}
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
              // `text`, not `number` (the set-balance box's reason): a number
              // input silently drops what it cannot parse, so a pasted
              // "1,250.00" arrives empty and a quantity is "required".
              type="text"
              inputMode="decimal"
              className="cell-input"
              aria-label={`Quantity of ${holding.instrumentName}`}
              aria-invalid={errors?.quantity ? true : undefined}
              aria-describedby={errors?.quantity ? "revise-error-quantity" : undefined}
              autoComplete="off"
              // The one place a correction starts, so it is where the cursor
              // goes when the row opens.
              autoFocus
            />
          ) : (
            <Amount value={holding.quantity} shape="quantity" />
          )}
        </td>
        {/* Null price and null value are the same holding: never quoted. A dash
            says so; a zero would understate the portfolio by the whole position
            and look deliberate. */}
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
              // The column prints the whole position's basis and the box takes
              // one share's, which is the number a statement prints and the
              // number the column is stored from. Said in the label rather than
              // left to be inferred from a figure that will not match.
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
        {/* `$0`, not a dash, for an instrument carrying no rate — even one
            nobody can price, which pairs a blank Value with a `$0` here.
            That looks wrong and is the accepted limitation working as chosen
            (§14, limitation 9): `quote` cannot tell "pays nothing" from
            "nobody asked". A plain `Amount`, not `Delta`: a payout is not a
            movement — no arrow, no leading plus, and a liability's rate
            keeps its minus. Amount and percentage share a wrapper so the
            phone gets one right-aligned block against the card's label. */}
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
              // "Edit" forty times over is forty identical entries in a screen
              // reader's list of links. The row is what distinguishes them.
              aria-label={`Correct ${holding.instrumentName} in ${holding.accountName}`}
              preventScrollReset
            >
              <EditIcon />
            </Link>
          )}
        </td>
      </tr>

      {open ? (
        // The editor's footer: what saving will do, and the two controls that
        // do it. Save and Cancel are *here*, not in the actions cell — that
        // column is sized `width: 1%` to its 32px resting control, and two
        // buttons in it widened the table into a horizontal scroll to reach
        // Save. This row is already full width and already carries the
        // sentence explaining the click.
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
                  // Said before the click (the set-balance form's rule): what
                  // saving does is not what "edit" usually means, and a
                  // reader expecting one number overwritten would not expect
                  // a new statement carrying every other position forward.
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

/**
 * What the totals were computed from (§8.2: sum what is known and label the
 * coverage). Three counts, not one, because they are genuinely three: a
 * workplace plan reports a price and no cost basis (value complete,
 * unrealized short), and an unquotable instrument is the reverse. One
 * "40 of 42" would pick one and misreport the others.
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

