/**
 * Owner filter control (spec 0013, ADR-0008): summary naming who's shown,
 * opening onto a checkbox per owner and Apply. A disclosure, not a row of
 * boxes — a fixed shape that doesn't reflow with household size. No client
 * state — `<details>`, a GET form, a link; hidden fields carry the host
 * screen's own params so applying a filter doesn't reset them. Keyed on
 * `location.key` so client-side nav resets it like a document load would
 * (mechanism in the checkbox comment below). Not drawn under two owners,
 * unless a filter is already on — counts people, not on-screen values, since
 * an owner holding nothing is still someone to read the household as.
 */
import { Form, Link, useLocation } from "react-router";

import { joinWords } from "~/lib/format";
import { isFiltered, ownerSearch, type OwnerFilter } from "~/lib/owner-filter";

export type FilterableOwner = { id: string; name: string };

export function OwnerFilterControl({
  owners,
  selected,
  hidden,
}: {
  owners: ReadonlyArray<FilterableOwner>;
  selected: OwnerFilter;
  // Host screen's own non-default params, re-emitted so applying a filter
  // doesn't reset them. Never `edit`/`saved` — see `holdings.tsx`.
  hidden: Record<string, string>;
}) {
  // Before the early return below, unconditionally — this is a hook.
  const location = useLocation();

  // Unless a filter is already on (e.g. a bookmark) — else no way to clear it.
  if (owners.length < 2 && !isFiltered(selected)) return null;

  const chosen = new Set(selected);
  const narrowedTo = owners.filter((owner) => chosen.has(owner.id));

  return (
    // Navigation's key, not the selection's — ticking every owner collapses
    // to `?owner=` nothing (ADR-0008), so a key of the selection would hold
    // stale ticked boxes over a screen now reading "Everyone".
    <details key={location.key} className="owner-filter">
      <summary aria-current={isFiltered(selected) ? "true" : undefined}>
        <span className="u-label">Owner</span>
        <span className="owner-filter-summary">{summarise(narrowedTo, owners, selected)}</span>
      </summary>

      <Form
        method="get"
        className="filter-bar owner-filter-menu"
        aria-label="Filter by owner"
      >
        <fieldset className="owner-filter-owners">
          <legend className="u-label">Show</legend>
          {owners.map((owner) => (
            <label key={owner.id} className="choice" htmlFor={`owner-${owner.id}`}>
              {/* Repeated `owner=` params, before the hidden fields below —
                  DOM order must match the canonical address (`canonicalOwnerSearch`)
                  or the roster's name-sorted boxes still cost a respelling bounce.
                  `defaultChecked` alone won't follow the address: React sets a
                  checkbox's dirty-checkedness flag at hydration regardless of
                  clicks, so only the disclosure's `key` above (remounting this)
                  keeps a box in sync — invisible to any server-rendered test. */}
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

        {/* After the fieldset — DOM order must keep `owner=` before the rest, or the canonical address costs a redirect. */}
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}

        <div className="filter-actions">
          <button type="submit" className="button">
            Apply
          </button>
          {isFiltered(selected) ? (
            <Link className="button button--text" to={clearedTo(hidden)}>
              Show everyone
            </Link>
          ) : null}
        </div>
      </Form>
    </details>
  );
}

// Names while few enough to read, a count past that — width must not track household size.
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

function clearedTo(hidden: Record<string, string>): string {
  const search = new URLSearchParams(hidden).toString();

  return search === "" ? "." : `?${search}`;
}

// ADR-0008: filter survives navigation, so this sentence — not a chip alone — must say who. Masked-safe: names, not amounts.
export function NarrowedTo({ owners }: { owners: ReadonlyArray<FilterableOwner> }) {
  if (owners.length === 0) return null;

  return (
    <p className="narrowed-to">
      Showing <b>{joinWords(owners.map((owner) => owner.name))}</b> only.
    </p>
  );
}

// Address is stale, not the household empty. Exported — Holdings uses the same sentence in its own panel note.
export const UNREADABLE_OWNER =
  "This view is set to an owner the household can no longer be read as — removed, or left holding only closed accounts.";

// "Alice holds", "Alice and Bob hold" — same fragment both screens use.
export function holdsNothing(names: ReadonlyArray<FilterableOwner>): string {
  return `${joinWords(names.map((owner) => owner.name))} ${names.length === 1 ? "holds" : "hold"}`;
}

// Not `EmptyState` — that headline is fixed and false on an instance full of data.
export function NarrowedToNothing({
  owners,
  unknownOwner,
  showEveryone,
}: {
  owners: ReadonlyArray<FilterableOwner>;
  unknownOwner: boolean;
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
