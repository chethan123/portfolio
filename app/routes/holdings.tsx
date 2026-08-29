import { Form, Link, redirect } from "react-router";

import { Amount, Delta } from "~/components/amount";
import { EmptyState } from "~/components/empty-state";
import { NarrowedTo, OwnerFilterControl } from "~/components/owner-filter-control";
import { ChevronRightIcon, EditIcon } from "~/components/icons";
import { isNegative } from "~/lib/format";
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
import { ALL_OWNERS, isFiltered, readOwnerFilter, type OwnerFilter } from "~/lib/owner-filter";
import { filterableOwners } from "~/lib/people.server";
import { currentPosition, effectiveDate, revisePosition } from "~/lib/positions.server";
import { currentHoldings } from "~/lib/valuation.server";

import { PriceFreshness, type FreshnessView } from "../components/price-freshness.tsx";
import { asOfView } from "../lib/prices.server.ts";
import { getConfig } from "../../server/config.ts";

import type { Route } from "./+types/holdings";

/**
 * Holdings — every position across every account, grouped and filterable.
 *
 * DESIGN.md §8.1's workhorse: "a groupable, filterable Holdings table absorbs
 * what would otherwise be four more pages — by person, by account, tax view,
 * unrealized. Those are the same table with the grouping changed, not separate
 * features."
 *
 * The whole screen is one query and one array. `currentHoldings(ALL_OWNERS)` returns the
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
 *
 * That rule is also what decides the shape of the one write this screen has
 * (§5.4). "Editable cells" is a `useState` per row and a table where any figure
 * is one mis-click from being overwritten; `?edit=12.7` is a link, and it opens
 * exactly one row, and it survives a reload, and it works with JavaScript off.
 * The editor is the screen's existing grammar applied to a form rather than a
 * new mechanism bolted beside it.
 */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams);
  // Household-wide and not one of `query`'s own dimensions (ADR-0008): it
  // followed the reader here from another screen and it follows them off this
  // one. Read before the redirect below, because `toSearch` spells it.
  const owners = readOwnerFilter(url.searchParams);

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

  // `edit` and `saved` are deliberately *not* part of `HoldingsQuery`.
  //
  // They are not how you are reading the table, they are one thing you are
  // doing to one row of it, and keeping them out of the query object is what
  // makes every control on the screen close the editor for free: each of those
  // controls is a link built by `toSearch`, which knows nothing about either
  // parameter and therefore drops both. Filtering while a row is open should
  // not carry a half-typed correction into a different view, and adding a field
  // to `HoldingsQuery` would have had it do exactly that on all seven controls
  // at once.
  //
  // They are still canonicalised, by being re-serialised from the pair they
  // parse to rather than echoed: a mangled `edit=` bounces to the URL without
  // it, which is the same "no editor" a missing one produces.
  const editing = parseRowKey(url.searchParams.get("edit"));
  const saved = parseRowKey(url.searchParams.get("saved"));

  const view = toSearch(query, owners);
  // A receipt supersedes an editor rather than sitting beside one: `saved` is
  // where the write redirects to, and the row it names has just been closed.
  const canonical =
    saved !== null ? withRow(view, "saved", saved) : withRow(view, "edit", editing);
  if (url.search !== canonical) throw redirect(`${url.pathname}${canonical}`);

  const [household, freshness, roster] = await Promise.all([
    currentHoldings(ALL_OWNERS),
    asOfView(getConfig().MARKET_TIMEZONE),
    filterableOwners(),
  ]);

  // Narrowed in SQL, through the same predicate every other screen reads
  // through, rather than by filtering `household` here — which would be a
  // second implementation of one rule, free to disagree with the first about
  // an id no person carries. A second round trip, and only while narrowed.
  const holdings = isFiltered(owners) ? await currentHoldings(owners) : household;

  // The filter controls are built from *every* holding, not from the filtered
  // set: options that vanished as you narrowed would leave no way to widen
  // again. That now includes narrowing by owner, so they are built from
  // `household` rather than from what the owner filter left.
  const filters = availableFilters(household, query);
  const visible = applyFilters(holdings, query);

  // Who the filter actually names, in the roster's order. An id naming nobody
  // — or naming somebody whose accounts have all been closed, which is the same
  // sentence to a reader — leaves this shorter than the selection.
  const narrowedTo = roster.filter((person) => owners.includes(person.id));

  // The receipt quotes the database, never the URL.
  //
  // `?saved=` says *which* row was written and nothing about what was written
  // to it, and the figures beside the confirmation are read back out of
  // `currentHoldings(ALL_OWNERS)` here — so a hand-typed parameter can only ever produce
  // a sentence describing what the account actually holds, which is the
  // guarantee Account detail's `?recorded=` has for the same reason (§13.7).
  // Looked up in every holding rather than in the filtered set, so that the
  // sentence still appears if the write is confirmed from a narrowed view.
  const open = saved === null ? editing : null;

  const written =
    saved === null
      ? null
      : (holdings.find(
          (holding) =>
            holding.accountId === saved.accountId && holding.instrumentId === saved.instrumentId,
        ) ?? null);

  return {
    freshness,
    /** The roster the control draws, and the selection it draws as ticked. */
    roster: roster.map((person) => ({ id: person.id, name: person.name })),
    owners,
    narrowedTo: narrowedTo.map((person) => ({ id: person.id, name: person.name })),
    /**
     * The filter names an id the roster does not: a hand-typed one, or an owner
     * whose accounts have all been closed. One sentence and one fix to a
     * reader, so one state.
     */
    unknownOwner: isFiltered(owners) && narrowedTo.length < owners.length,
    /** The selected owners hold nothing. Not an error, and not an empty instance. */
    ownersHoldNothing: isFiltered(owners) && household.length > 0 && holdings.length === 0,
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
    /** The canonical view, with no row open and no receipt — every Cancel goes here. */
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
     * The date the open row's correction will be filed under.
     *
     * From the server, so it is not a date the reader's clock invented — and
     * through the same {@link effectiveDate} the write uses, so it is not
     * merely today either. A statement may legitimately be dated tomorrow, and
     * a correction against it carries that date instead; a note promising
     * "dated today" would then be the screen misreporting its own effect, which
     * is exactly the thing the note exists to prevent.
     *
     * One extra query, and only while a row is open.
     */
    asOf:
      open === null
        ? null
        : effectiveDate((await currentPosition(open.accountId, open.instrumentId))?.asOf ?? ""),
  };
}

/**
 * Restate one position.
 *
 * The route reads two boxes and hands them over; everything that decides
 * whether the correction is allowed, and everything that decides what lands in
 * the database, is in `positions.server.ts` (§5.4).
 *
 * **Which row is being corrected comes from the URL, not from a hidden field.**
 * The form posts back to the address that opened it — `?…&edit=12.7` — so the
 * row's identity travels the same way the rest of this screen's state does, and
 * there is no field a submission could carry that disagrees with the page it
 * was submitted from.
 *
 * The redirect target is rebuilt by `toSearch` from a parsed query rather than
 * taken from what arrived, which is what keeps it a Holdings view: the only
 * strings it can produce are the ones this screen already speaks.
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

    // Redirect rather than render, for the three reasons Account detail gives:
    // a reload cannot re-submit the write, the boxes are gone because this is a
    // fresh GET rather than the same elements re-rendered, and the confirmation
    // is forced to describe what the database says instead of what the
    // submission claimed.
    // The owner filter comes off the same URL the row's identity does, so the
    // correction returns to the narrowed view rather than to the household's.
    // No hidden field: the form posts back to the address that opened it.
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
    ownersHoldNothing,
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
  // The owner filter counts here as much as this screen's own do. Without it a
  // table narrowed to one person reads as the whole portfolio to anyone who did
  // not set the filter — which is the honesty condition ADR-0008 attaches to
  // the filter surviving navigation, and the notice below is where it is kept.
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

  // Clearing the filters clears the filters. The grouping and the sort are how
  // you were reading the table rather than what you were reading, and the form
  // above already carries them through an Apply for exactly that reason — a
  // "Clear" beside it that quietly threw them away would undo more than it
  // says.
  //
  // The owner filter is not this screen's to clear either, and for a stronger
  // reason: it is household-wide, so clearing it from here would reach out and
  // change what Overview shows next. "Show everyone" lives on the owner control
  // itself, which is where the reader set it.
  const cleared = toSearch({ ...query, filters: new Map() }, owners) || ".";
  const columns = columnsFor(group);
  // One column past the data columns: the row's own Edit control. It sorts by
  // nothing and sums to nothing, so it is not a `Column` — the array is what
  // the headers, the sort links and `columnsFor` are all built from, and an
  // entry in it with no `SortKey` would have to be special-cased in each.
  const span = columns.length + 1;
  const labelSpan = columns.length - FIGURES;

  // The one state that may say nothing has been uploaded, because it is the
  // only one where nothing has been. An owner filter that reaches no holdings
  // is an instance full of data this reading does not reach, and it falls
  // through to the panel below — which is where this screen has always drawn
  // "the question has an answer and it is nothing", and says so without the
  // false claim.
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
          // Not the empty state above. The instance has data; this particular
          // question has no answer, and saying "there is no data yet" would be
          // a different and false claim. That is now three questions rather
          // than one — this screen's own filters, an owner naming nobody, and
          // owners who hold nothing — and each gets its own sentence and its
          // own way out.
          <div className="panel-body panel-body--empty">
            <p className="empty-note">
              {describe(filters, narrowedTo, unknownOwner)}{" "}
              <span className="u-data">{totalHoldings}</span>{" "}
              {totalHoldings === 1 ? "holding is" : "holdings are"} recorded in all.
            </p>
            {/* The `.button--text` §7.2 names, and not a link inside the
                sentence. This screen already draws one "Clear filters" as a
                40px text button in the bar above; drawn a second time as an
                underlined 17px inline link — the only underlined-at-rest link
                on the page — the same words pointing at the same URL were two
                different components 280px apart. */}
            {active.length > 0 ? (
              <Link className="button button--text" to={cleared}>
                Clear filters
              </Link>
            ) : null}
            {/* Its own way out, because the owner filter is not this screen's
                to clear: it is household-wide, and this link says so by naming
                everyone rather than by saying "clear". */}
            {isFiltered(owners) ? (
              <Link className="button button--text" to={toSearch(query, ALL_OWNERS) || "."}>
                Show everyone
              </Link>
            ) : null}
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
                      <SortHeader key={column.key} column={column} query={query} owners={owners} />
                    ))}
                    {/* Named for a screen reader and blank for everyone else:
                        a word over a column of icons would be a heading for a
                        control rather than for data, and on the phone the head
                        row is a strip of sort links where it would read as one
                        more of those. */}
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
function describe(
  filters: Route.ComponentProps["loaderData"]["filters"],
  narrowedTo: Route.ComponentProps["loaderData"]["narrowedTo"],
  unknownOwner: boolean,
): string {
  // The owner filter first, because it is the more fundamental fact: if the
  // household cannot be read as these people at all, or they hold nothing,
  // then what this screen's own selects say about the rest is beside the point.
  if (unknownOwner) {
    return "This view is set to an owner the household can no longer be read as — removed, or left holding only closed accounts.";
  }

  if (narrowedTo.length > 0 && filters.every((filter) => filter.selected === "")) {
    const named = join(narrowedTo.map((person) => person.name));

    return `${named} ${narrowedTo.length === 1 ? "holds" : "hold"} nothing that has been recorded here.`;
  }

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
 * This screen's own state, for the owner control's hidden fields.
 *
 * A GET form submits its own fields and nothing else, so changing the owner
 * would otherwise reset the sort, the grouping and every dimension filter.
 * Defaults are left out, for `toSearch`'s reason: the unfiltered table's URL is
 * `/holdings`.
 *
 * `edit` and `saved` are not here and must never be. They are one thing you are
 * doing to one row rather than how you are reading the table, and narrowing
 * while a row is open must not carry a half-typed correction into a different
 * view — the rule the loader states for every other control on this screen.
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
      {/* The owner filter travels with every other control on this screen, or
          picking an account type would silently widen the table back to the
          whole household. */}
      {owners.length > 0 ? <input type="hidden" name="owner" value={owners.join(",")} /> : null}
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
 *
 * The caption is what brief §4.1 opens with, and it doubles as the strip's
 * accessible name rather than sitting beside a second one. The strip stands on
 * the canvas between two panels with no heading over it, so a screen reader had
 * "Group holdings by" and everyone else had eight chips and nothing on screen
 * saying what they group — the leading chip reading "No grouping" was the only
 * hint. Pointing `aria-labelledby` at the visible words is also what stops the
 * two names drifting apart the next time one of them is edited.
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
 * A column heading that sorts.
 *
 * `aria-sort` on the header is what tells a screen reader which column the
 * table is ordered by and in which direction — the caret beside the label says
 * the same thing to everyone else, and neither is left to carry it alone.
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

  // A figure and its caption share a wrapper, exactly as the annual-dividend
  // cell of a row already does, and below 768px that wrapper is the whole
  // difference between the four figures sharing a right edge and not. There the
  // cell becomes a `display: flex` label-and-figure row (§8), and
  // `space-between` distributes however many items it is handed: bare, a
  // partial column hands it three — label, figure, caption — and parks the
  // money in the middle of the card, so three of the grand total's four figures
  // sat at 236, 254 and 264px against a complete column's 357 and against every
  // figure in the cards above them. Wrapped, it hands over two whatever the
  // coverage is, and `.cell-sub`'s own `display: block` puts the count back
  // directly beneath its figure — where §7.3 puts it, and where it already sits
  // on desktop.
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
      {/* No caption, and no weighted yield either.

          No caption because there are no unknowns to count: the view coalesces
          a missing rate to zero, so this figure is summed from every row above
          it and "4 of 4" would be noise on a column that is complete by
          construction.

          No percentage because the one under a row is that row's own — a
          fraction of a single holding's value. The same ratio taken over a
          subtotal is a *weighted* yield, a different figure with the group's
          value as its denominator and its own undefined cases, and the screen
          it belongs on is Income. Printing it here in the same typeface as the
          row percentages would invite them to be read as the same number. */}
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
 * One holding, and — for at most one of them at a time — the boxes that correct
 * it (§5.4).
 *
 * **The inputs are in their own columns and the form is in the row beneath.** A
 * `<form>` cannot wrap a `<tr>`; the only legal places for one inside a table
 * are inside a cell. Putting the whole editor in a single cell would take the
 * quantity out of the Quantity column and out of its right-aligned tabular
 * figures, which is most of what makes an inline correction readable — you are
 * meant to be checking the number against the ones above and below it. So the
 * form element sits in the full-width row below and the inputs join it by
 * `form=`, which is what the attribute is for, and which associates a control
 * with a form wherever either one sits in the document.
 *
 * **Price, Value and Unrealized keep showing the stored figures while a row is
 * open.** They are what the correction is being made against. Blanking them, or
 * projecting them from the half-typed quantity, would replace the reference
 * with a guess at the exact moment it is being read.
 *
 * The boxes open on `formatQuantity`'s output rather than on the raw column, so
 * a row reading `120.5` opens as `120.5` and not as `120.50000000` — and
 * `signedQuantity` and `perShareAmount` were written to take that spelling
 * back, U+2212 and thousands separators and all, precisely so the prefill and
 * the parser could be the same string.
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

  // Every refusal, in a fixed order, gathered for the line beneath the row.
  //
  // They go there rather than under the box each belongs to because the boxes
  // are in table columns: "A quantity must be a number, like 120.5 — or −8,000
  // for something owed." is a sentence, and the Quantity column is as wide as
  // the widest share count in the household. A message set in a 6rem column
  // either wraps to five lines or widens the column and shifts every figure in
  // the table sideways, and it does whichever it does at the moment the reader
  // is trying to read it. The full-width line below has room for the sentence;
  // `aria-invalid` and `aria-describedby` are what keep it attached to its box
  // for a reader who is not looking at the layout at all.
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
              // `text`, not `number`, for the reason the set-balance box gives:
              // a number input silently drops what it cannot parse, so a pasted
              // "1,250.00" arrives as an empty string and the family is told a
              // quantity is required. The parsing this app wants is exact and
              // lives in `input.server`.
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
        {/* `$0`, not a dash, for a holding whose instrument carries no rate —
            including one nobody can price, which shows a blank Value and a `$0`
            here in the same row. That pairing looks wrong and is the accepted
            limitation working as chosen (DESIGN.md §14, limitation 9): `quote`
            cannot tell "the provider said it pays nothing" from "nobody asked",
            so both are read as nothing.

            A plain `Amount` rather than a `Delta`: a payout is not a movement,
            so it takes no arrow and no leading plus, and a liability whose note
            carries a rate keeps its minus like every other negative figure in
            the table.

            The amount and the percentage share a wrapper so that the phone gets
            one right-aligned block against the card's `data-label`, rather than
            two flex items pushed apart by it. */}
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
        // The line beneath the open row is the editor's footer: what saving
        // will do, and the two controls that do it.
        //
        // Save and Cancel are *here* rather than in the actions cell, which is
        // where they started. That column is sized by `width: 1%` to the 32px
        // control it holds at rest, and two buttons in it widened the table
        // past its panel — putting the whole screen into a horizontal scroll to
        // reach a Save button, on the one interaction that is supposed to be
        // quick. This row is already full width and already carries the
        // sentence explaining the click, so the button belongs beside it.
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
                  // Said before the click rather than after it, exactly as the
                  // set-balance form says its own version: what saving does
                  // here is not what "edit" usually means, and a reader who
                  // expects one number to be overwritten would not expect a
                  // statement dated today to appear carrying every other
                  // position in the account.
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

