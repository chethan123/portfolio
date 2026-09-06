// Owner-filter reading (spec 0013, ADR-0008): the single place that turns ?owner= into what a
// screen may believe it means — replaces four drifting near-duplicate loader preambles.
// .server.ts because it imports ownerRoster; owner-filter.ts stays plain for the browser-side
// control.
//
// Order: parse filter from URL -> redirect to canonical spelling (needs no DB) -> read roster
// once -> redirect an everyone-selection to the no-owner-param address (ADR-0008) -> resolve
// `reading` against the roster, never raw ids -> project into OwnerBlock.
//
// Doesn't read money: ADR-0008's point is that a screen reading the whole household says
// ALL_OWNERS visibly at its own call site, so money reads stay in the loader / chart-series.server.ts.
// `reading` != raw filter because holding_valued_at admits accounts closed after the date asked
// about — a stale/removed id must not reach a dated reader. A selection resolving to nobody keeps
// the raw ids though: `[]` means "whole household" (owner-filter.ts forbids that widening).
//
// Invariants on every return:
// 1. address settled: url.search === address.request(owners); resolved.coversEveryone is false.
// 2. isFiltered(owners) === isFiltered(reading).
// 3. reading is [] only when owners is [] — never widens.
// 4. at most two redirects.
// 5. every OwnerBlock field is plain data.
import { redirect } from "react-router";

import {
  ALL_OWNERS,
  canonicalOwnerSearch,
  isFiltered,
  readOwnerFilter,
  type OwnerFilter,
} from "./owner-filter.ts";
import { ownerRoster, type Person } from "./people.server.ts";

/**
 * How a screen spells its own address, in the two roles an address plays.
 * Omitted by the three screens whose grammar is "the owner parameter
 * canonically and first, everything else kept" — `canonicalOwnerSearch`'s own
 * description, and the default here.
 *
 * The two differ only where a screen carries state belonging to THIS request
 * rather than to the reading. Holdings does: `?edit=` and `?saved=` name one
 * row being worked on, a bounce must not close an editor the reader had open,
 * and no link built from the view may carry either.
 */
export type ScreenAddress = {
  /** The address this request should be reading, for a selection. Row state kept. */
  request(owners: OwnerFilter): string;
  /** The address a link to this screen carries, for a selection. Row state dropped. */
  link(owners: OwnerFilter): string;
};

/** The owner block of a loader's payload. Plain data; spread it into the return. */
export type OwnerBlock = {
  owners: OwnerFilter;
  roster: Array<{ id: string; name: string }>;
  narrowedTo: Array<{ id: string; name: string }>;
  unknownOwner: boolean;
  /** The unfiltered address, never `""`: a `<Link to="">` is the page it is
   * already on, so a screen whose unfiltered address is bare (Analysis,
   * Income, Overview) needs `"."` for "Show everyone" to go anywhere. */
  showEveryone: string;
};

export type OwnerReading = {
  /** What every household-scoped reader on this screen narrows by. */
  reading: OwnerFilter;
  /** What the screen returns about whose money it is showing. */
  owner: OwnerBlock;
};

/** A roster row projected to what a payload needs — no `accountCount` to strip later. */
function project(people: Person[]): Array<{ id: string; name: string }> {
  return people.map((person) => ({ id: person.id, name: person.name }));
}

/** The default {@link ScreenAddress}: the owner parameter canonically and first. */
function defaultAddress(params: URLSearchParams): ScreenAddress {
  return {
    request: (owners) => canonicalOwnerSearch(params, owners),
    link: (owners) => canonicalOwnerSearch(params, owners),
  };
}

/**
 * Settle the owner-filter reading for one request. Throws a redirect
 * `Response` — rather than returning one for the caller to translate — when
 * the address is not yet settled; a loader that awaits this is either
 * unreachable past this point, or holding a settled `OwnerReading`.
 */
export async function ownerReading(
  request: Request,
  address?: ScreenAddress,
): Promise<OwnerReading> {
  const url = new URL(request.url);
  const owners = readOwnerFilter(url.searchParams);
  const spell = address ?? defaultAddress(url.searchParams);

  // `!==` gives one view one *form-normal* URL, not one URL: `url.search`
  // here is react-router's own rebuild of the request through the
  // form-urlencoded serialiser, not the address sent (`callRouteHandler`).
  // A spelling that is not a fixed point of that serialiser loops on every
  // request containing it, and `toOwnerParam` (`owner-filter.ts`) is built
  // so that it is.
  //
  // No runtime guard beyond that, though one was considered: a guard could
  // only check that the bounce target survives parsing, not that a speller is
  // idempotent — `?owner=1,3 → ?owner=3,1 → ?owner=1,3` passes such a check
  // and loops forever. Nor would it catch a `request` that is constant in
  // `owners` — ignores the argument and spells the same string regardless —
  // which makes the everyone bounce below loop on the very first hop: its
  // target, `spell.request(ALL_OWNERS)`, is then the same string as
  // `canonical` above, which `url.search` already equals for this request to
  // have reached that bounce at all, so the redirect answers with the address
  // it was just asked to serve. What actually catches a loop is following the
  // chain, which `tests/owner-reading.test.ts` does for this default grammar
  // and `holdings.test.ts` does for Holdings' own. A thrown `Error` would
  // also be a new failure mode — a 500 where today there is a redirect.
  const canonical = spell.request(owners);
  if (url.search !== canonical) throw redirect(`${url.pathname}${canonical}`);

  // The one query, first, alone: what step 5 below narrows by is the
  // selection *resolved against this*, so nothing else may read ahead of it.
  const resolved = await ownerRoster(owners);

  if (resolved.coversEveryone) {
    throw redirect(`${url.pathname}${spell.request(ALL_OWNERS)}`);
  }

  // Filtering `owners` rather than mapping `narrowedTo` keeps canonical
  // order; the set of ids is identical either way.
  const narrowed = owners.filter((id) => resolved.narrowedTo.some((person) => person.id === id));
  const reading = narrowed.length > 0 ? narrowed : owners;

  return {
    reading,
    owner: {
      owners,
      roster: project(resolved.people),
      narrowedTo: project(resolved.narrowedTo),
      unknownOwner: resolved.unknownOwner,
      showEveryone: spell.link(ALL_OWNERS) || ".",
    },
  };
}

/**
 * Empty because the filter reached nothing, rather than because the instance
 * has nothing — two different sentences, and only the second may say nothing
 * has been uploaded. Both counts are taken off rows the loader already read.
 *
 * `instance` is a plain number, never nullable. A screen that is not
 * narrowed passes its own count for both, which is the same number; nothing
 * is left for a caller to get wrong.
 *
 * Named `isNarrowedToNothing`, not `narrowedToNothing`, to match `isFiltered`
 * and to keep the name from binding three ways in one file on a screen that
 * both imports and destructures it.
 */
export function isNarrowedToNothing(
  owners: OwnerFilter,
  counts: { held: number; instance: number },
): boolean {
  return isFiltered(owners) && counts.instance > 0 && counts.held === 0;
}
