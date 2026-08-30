/**
 * The owner filter's control (spec 0013, ADR-0008).
 *
 * A summary naming who is being shown, opening onto a checkbox per owner and an
 * Apply button. It is drawn in the page header's actions on every screen the
 * filter reaches: the header is the one slot the four screens share, since
 * Overview's chart range lives in its hero section rather than its header, so
 * "beside the range" would name a different place on each.
 *
 * **A disclosure rather than a row of boxes**, which is what it was. A row grows
 * with the household — five names is wider than the header has to spare, and it
 * reflowed the strip differently on every screen and every viewport, so the one
 * control that is meant to look identical everywhere was the one that did not.
 * The closed summary is a fixed shape, so what the header does no longer depends
 * on how many people are recorded.
 *
 * **The summary says who is being shown**, the way the range control's Custom
 * option shows its applied span rather than the word "Custom": a filter that
 * survives navigation must be legible without being opened. Names while there
 * are few enough to read, a count past that, and the ellipsis is a hard stop so
 * that a long name cannot widen the header either.
 *
 * **It reuses `.filter-bar`'s look for the panel and extracts nothing from
 * `Filters`.** That bar is a `<select>` per dimension; this is a checkbox list
 * over one. What they share is a panel that happens to be a form, which is a
 * stylesheet's job — pulling a component out of two controls with different
 * inputs would be the more elaborate shape, not the simpler one.
 *
 * **No client-side state**, like every other control here: `<details>` is the
 * browser's own disclosure, the whole of the rest is a GET form and a link, and
 * it works with scripting off — the same contract the range control's Custom
 * picker already keeps. (A React Router `<Form>` rather than a bare one, which
 * buys a client-side navigation where JavaScript is running and changes nothing
 * where it is not.) Its hidden fields are how a GET form changes one thing
 * without resetting the others, and they arrive as a prop because the control
 * knows no screen's vocabulary — Holdings passes its own filters, grouping and
 * sort, Overview its `range`/`start`/`end`, and neither has to be named here.
 *
 * **Not drawn at all when fewer than two people own an open account** — unless
 * a filter is on, in which case it draws whatever the roster holds, because it
 * is then the one control that can clear it. The threshold is the spirit of
 * `availableFilters`' one-option rule, not its code: that rule counts distinct
 * values among the holdings on screen, and this counts people, because an
 * owner who holds nothing is still someone the reader may want to read the
 * household as. Following the holdings would hide the control on the screen an
 * owner happens to be absent from, which is the wrong answer for a filter that
 * spans four of them.
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
  // One name is not a choice, and nobody at all is not a filter — unless a
  // filter is already on. A household of one selectable owner can still carry
  // `?owner=` from a bookmark or from a person losing their last open account
  // after the link was made, and a control that vanished then would leave the
  // filter with no way off the screen: the nav carries it, and "Show everyone"
  // below is the only control that clears it.
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
    </details>
  );
}

/**
 * What the closed control says it is showing.
 *
 * Names while there are few enough to read at a glance, and a count past that —
 * the point of the disclosure is a summary whose width does not track the size
 * of the household, and four names spelled out would put the row back where it
 * started. Two is the threshold because two is what the sentence beside the
 * figure already spells out in full.
 *
 * An id naming nobody is deliberately visible here rather than silently
 * dropped: `narrowedTo` is the roster's answer and `selected` is what the
 * address asked for, so a selection the roster cannot account for reads as a
 * count that does not match the names. The screen's own empty state says it in
 * words; this only has to avoid claiming otherwise.
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
      Showing <b>{joinWords(owners.map((owner) => owner.name))}</b> only.
    </p>
  );
}

/**
 * The address is stale rather than the household empty: this selection names
 * somebody the household cannot be read as.
 *
 * Exported because Holdings says the same thing in its own panel note, and one
 * household described two ways on adjacent pages is exactly what a second copy
 * of a sentence buys.
 */
export const UNREADABLE_OWNER =
  "This view is set to an owner the household can no longer be read as — removed, or left holding only closed accounts.";

/** "Alice holds", "Alice and Bob hold" — the same fragment both screens use. */
export function holdsNothing(names: ReadonlyArray<FilterableOwner>): string {
  return `${joinWords(names.map((owner) => owner.name))} ${names.length === 1 ? "holds" : "hold"}`;
}

/**
 * What a screen says when the owner filter is the reason it has nothing to show.
 *
 * Deliberately **not** `EmptyState`, whose headline is the fixed *"There is no
 * data yet."* — a false claim on an instance full of it, and the same
 * distinction `holdings.tsx` has always drawn between an empty instance and a
 * question whose answer happens to be nothing. Only a genuinely empty instance
 * may say nothing has been uploaded.
 *
 * Two sentences rather than one, because the two are a different fix to a
 * reader: an id naming nobody is a stale address, and an owner holding nothing
 * is a fact about the household. Neither may sound like an error.
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
