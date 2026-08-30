/**
 * The owner filter's control (spec 0013, ADR-0008): a summary naming who is
 * shown, opening onto a checkbox per owner and Apply. Drawn in the page
 * header's actions — the one slot the four screens share (Overview's range
 * lives in its hero, so "beside the range" names a different place on each).
 *
 * **A disclosure, not a row of boxes**: a row grows with the household and
 * reflowed the strip differently per screen and viewport — the one control
 * meant to look identical everywhere was the one that did not. The closed
 * summary is a fixed shape.
 *
 * **The summary says who is being shown** (as the range control's Custom
 * shows its applied span): a filter that survives navigation must be legible
 * without being opened. Names while few enough to read, a count past that;
 * the ellipsis is a hard stop so a long name cannot widen the header.
 *
 * **Reuses `.filter-bar`'s look, extracts nothing from `Filters`**: that bar
 * is a `<select>` per dimension, this a checkbox list over one — a shared
 * look is a stylesheet's job, and a component pulled out of two controls
 * with different inputs is the more elaborate shape, not the simpler.
 *
 * **No client-side state**: `<details>` is the browser's own disclosure, the
 * rest a GET form and a link, working with scripting off (a React Router
 * `<Form>` buys client-side navigation where scripts run, changes nothing
 * where they don't). Hidden fields are how a GET form changes one thing
 * without resetting the rest, and arrive as a prop because the control knows
 * no screen's vocabulary — Holdings passes its filters, grouping and sort,
 * Overview its `range`/`start`/`end`.
 *
 * **Not drawn when fewer than two people own an open account** — unless a
 * filter is on, when it draws whatever the roster holds: it is then the one
 * control that can clear it. Counts people, not `availableFilters`' distinct
 * on-screen values: an owner holding nothing is still someone to read the
 * household as, and following the holdings would hide the control on
 * whichever screen an owner is absent from — wrong for a filter spanning
 * four of them.
 */
import { Form, Link } from "react-router";

import { joinWords } from "~/lib/format";
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
  // One name is not a choice, and nobody at all is not a filter — unless one
  // is already on: a household of one selectable owner can still carry
  // `?owner=` from a bookmark, and a control that vanished then would leave
  // the filter with no way off the screen ("Show everyone" below is the only
  // control that clears it).
  if (owners.length < 2 && !isFiltered(selected)) return null;

  const chosen = new Set(selected);
  const narrowedTo = owners.filter((owner) => chosen.has(owner.id));

  return (
    <details className="owner-filter">
      <summary aria-current={isFiltered(selected) ? "true" : undefined}>
        <span className="u-label">Owner</span>
        <span className="owner-filter-summary">{summarise(narrowedTo, owners, selected)}</span>
      </summary>

      <Form
        method="get"
        className="filter-bar owner-filter-menu"
        aria-label="Filter by owner"
      >
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <fieldset className="owner-filter-owners">
          <legend className="u-label">Show</legend>
          {owners.map((owner) => (
            <label key={owner.id} className="choice" htmlFor={`owner-${owner.id}`}>
              {/* Every box carries the same name, so a submission arrives as
                  a repeated parameter and the canonical redirect rewrites it
                  to the comma spelling — one bounce, like every GET form on
                  these screens. */}
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
    </details>
  );
}

/**
 * What the closed control says it is showing: names while few enough to
 * read at a glance, a count past that — the summary's width must not track
 * household size. Two is the threshold because two is what the sentence
 * beside the figure already spells out in full. An id naming nobody is
 * deliberately visible rather than dropped: `narrowedTo` is the roster's
 * answer, `selected` what the address asked, so an unaccountable selection
 * reads as a count that does not match the names — the screen's empty state
 * says it in words; this only has to avoid claiming otherwise.
 */
function summarise(
  narrowedTo: ReadonlyArray<FilterableOwner>,
  owners: ReadonlyArray<FilterableOwner>,
  selected: OwnerFilter,
): string {
  if (!isFiltered(selected)) return "Everyone";
  if (narrowedTo.length === 0) return "Nobody recorded";
  if (selected.length > narrowedTo.length || narrowedTo.length > 2) {
    return `${selected.length} of ${owners.length}`;
  }

  return joinWords(narrowedTo.map((owner) => owner.name));
}

/** Where Show everyone goes: this screen, its own state kept, no owner. */
function clearedTo(hidden: Record<string, string>): string {
  const search = new URLSearchParams(hidden).toString();

  return search === "" ? "." : `?${search}`;
}

/**
 * The sentence a narrowed screen puts beside the figure it narrowed.
 * ADR-0008 ties it to the filter surviving navigation: a reader who forgot
 * a filter set two screens ago would read a household headline that quietly
 * means something else — a chip alone does not do it; the words have to be
 * there. Masked-safe: names are never amounts.
 */
export function NarrowedTo({ owners }: { owners: ReadonlyArray<FilterableOwner> }) {
  if (owners.length === 0) return null;

  return (
    <p className="narrowed-to">
      Showing <b>{joinWords(owners.map((owner) => owner.name))}</b> only.
    </p>
  );
}

/**
 * The address is stale rather than the household empty: this selection
 * names somebody the household cannot be read as. Exported because Holdings
 * says the same thing in its own panel note — one household described two
 * ways on adjacent pages is exactly what a second copy of a sentence buys.
 */
export const UNREADABLE_OWNER =
  "This view is set to an owner the household can no longer be read as — removed, or left holding only closed accounts.";

/** "Alice holds", "Alice and Bob hold" — the same fragment both screens use. */
export function holdsNothing(names: ReadonlyArray<FilterableOwner>): string {
  return `${joinWords(names.map((owner) => owner.name))} ${names.length === 1 ? "holds" : "hold"}`;
}

/**
 * What a screen says when the owner filter is why it has nothing to show.
 * Deliberately **not** `EmptyState`, whose headline is the fixed "There is
 * no data yet." — false on an instance full of it; only a genuinely empty
 * instance may say nothing has been uploaded. Two sentences because the two
 * are different fixes to a reader: an id naming nobody is a stale address,
 * an owner holding nothing is a fact about the household. Neither may sound
 * like an error.
 */
export function NarrowedToNothing({
  owners,
  unknownOwner,
  showEveryone,
}: {
  owners: ReadonlyArray<FilterableOwner>;
  unknownOwner: boolean;
  /** Where "Show everyone" goes: this screen, its own state kept, no owner. */
  showEveryone: string;
}) {
  return (
    <div className="panel">
      <div className="panel-body panel-body--empty">
        <p className="empty-note">
          {unknownOwner ? UNREADABLE_OWNER : `${holdsNothing(owners)} nothing that has been recorded here.`}{" "}
          Everything else is still there.
        </p>
        <Link className="button button--text" to={showEveryone}>
          Show everyone
        </Link>
      </div>
    </div>
  );
}
