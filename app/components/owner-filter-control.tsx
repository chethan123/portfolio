/**
 * The owner filter's control (spec 0013, ADR-0008).
 *
 * A checkbox per owner and an Apply button, drawn in the page header's actions
 * on every screen the filter reaches. The header is the one slot the four
 * screens share: Overview's chart range lives in its hero section rather than
 * its header, so "beside the range" would name a different place on each.
 *
 * **It reuses `.filter-bar`'s look and extracts nothing from `Filters`.** That
 * bar is a `<select>` per dimension; this is a checkbox list over one. What
 * they share is a panel that happens to be a form, which is a stylesheet's job
 * — pulling a component out of two controls with different inputs would be the
 * more elaborate shape, not the simpler one.
 *
 * **No JavaScript**, like every other control here: a GET form and a link. Its
 * hidden fields are how a GET form changes one thing without resetting the
 * others, and they arrive as a prop because the control knows no screen's
 * vocabulary — Holdings passes its `group`/`sort`/`dir`, Overview its
 * `range`/`start`/`end`, and neither has to be named here.
 *
 * **Not drawn at all when fewer than two people own an open account.** The
 * spirit of `availableFilters`' one-option rule, not its code: that rule counts
 * distinct values among the holdings on screen, and this counts people, because
 * an owner who holds nothing is still someone the reader may want to read the
 * household as. Following the holdings would hide the control on the screen an
 * owner happens to be absent from, which is the wrong answer for a filter that
 * spans four of them.
 */
import { Form, Link } from "react-router";

import { isFiltered, ownerSearch, type OwnerFilter } from "~/lib/owner-filter";

/** A roster member: enough to draw a checkbox, and nothing about their money. */
export type FilterableOwner = { id: string; name: string };

export function OwnerFilterControl({
  owners,
  selected,
  hidden,
}: {
  /** Everyone who owns at least one open account, in the order to draw them. */
  owners: ReadonlyArray<FilterableOwner>;
  selected: OwnerFilter;
  /**
   * The host screen's own non-default parameters, re-emitted so that applying
   * a filter does not reset a sort or a range. `edit` and `saved` are never
   * among them: narrowing while a row is open must not carry a half-typed
   * correction, which is the rule `holdings.tsx` keeps for every other control
   * on that screen.
   */
  hidden: Record<string, string>;
}) {
  // One name is not a choice, and nobody at all is not a filter.
  if (owners.length < 2) return null;

  const chosen = new Set(selected);

  return (
    <Form method="get" className="filter-bar owner-filter" aria-label="Filter by owner">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <fieldset className="owner-filter-owners">
        <legend className="u-label">Owner</legend>
        {owners.map((owner) => (
          <label key={owner.id} className="choice" htmlFor={`owner-${owner.id}`}>
            {/* Every box carries the same name, so a submission arrives as a
                repeated parameter and the canonical redirect rewrites it to
                the comma-separated spelling. One bounce, which is how every
                GET form on these screens already behaves. */}
            <input
              id={`owner-${owner.id}`}
              type="checkbox"
              name="owner"
              value={owner.id}
              defaultChecked={chosen.has(owner.id)}
            />
            {owner.name}
          </label>
        ))}
      </fieldset>

      <div className="filter-actions">
        <button type="submit" className="button">
          Apply
        </button>
        {isFiltered(selected) ? (
          // `.` when the whole household's URL would be bare, the idiom the
          // Holdings filter bar's own Clear already uses.
          <Link className="button button--text" to={clearedTo(hidden)}>
            Show everyone
          </Link>
        ) : null}
      </div>
    </Form>
  );
}

/** Where Show everyone goes: this screen, its own state kept, no owner. */
function clearedTo(hidden: Record<string, string>): string {
  const search = new URLSearchParams(hidden).toString();

  return search === "" ? "." : `?${search}`;
}

/**
 * The sentence a narrowed screen puts beside the figure it narrowed.
 *
 * ADR-0008 attaches this to the filter surviving navigation: a reader who has
 * forgotten a filter set two screens ago would otherwise read a household
 * headline that quietly means something else. A chip alone does not do it —
 * the words have to be there.
 *
 * Masked-safe: it names people, and a name is never an amount.
 */
export function NarrowedTo({ owners }: { owners: ReadonlyArray<FilterableOwner> }) {
  if (owners.length === 0) return null;

  return (
    <p className="narrowed-to">
      Showing <b>{joinNames(owners.map((owner) => owner.name))}</b> only.
    </p>
  );
}

/** "Alex", "Alex and Jordan", "Alex, Jordan and Sam". */
function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
