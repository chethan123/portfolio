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

// request/link differ only for a screen with request-scoped state (Holdings: ?edit=/?saved=) —
// a bounce must keep it, a link must drop it. Omitted by screens using the plain
// canonicalOwnerSearch grammar (the default below).
export type ScreenAddress = {
  request(owners: OwnerFilter): string;
  link(owners: OwnerFilter): string;
};

export type OwnerBlock = {
  owners: OwnerFilter;
  roster: Array<{ id: string; name: string }>;
  narrowedTo: Array<{ id: string; name: string }>;
  unknownOwner: boolean;
  // Never "": <Link to=""> is the current page, so a bare unfiltered address needs "." instead.
  showEveryone: string;
};

export type OwnerReading = {
  reading: OwnerFilter;
  owner: OwnerBlock;
};

// No accountCount to strip later.
function project(people: Person[]): Array<{ id: string; name: string }> {
  return people.map((person) => ({ id: person.id, name: person.name }));
}

function defaultAddress(params: URLSearchParams): ScreenAddress {
  return {
    request: (owners) => canonicalOwnerSearch(params, owners),
    link: (owners) => canonicalOwnerSearch(params, owners),
  };
}

// Throws a redirect Response (rather than returning one) when the address isn't yet settled — a
// loader that awaits this is either unreachable past this point, or holding a settled OwnerReading.
export async function ownerReading(
  request: Request,
  address?: ScreenAddress,
): Promise<OwnerReading> {
  const url = new URL(request.url);
  const owners = readOwnerFilter(url.searchParams);
  const spell = address ?? defaultAddress(url.searchParams);

  // url.search is react-router's rebuilt form-urlencoded search, not the raw request
  // (callRouteHandler). No runtime loop-guard: toOwnerParam is instead built idempotent — a
  // guard that only checks the bounce target survives parsing wouldn't catch a non-idempotent
  // or argument-ignoring speller. Loop safety is tested by following the redirect chain
  // (tests/owner-reading.test.ts, holdings.test.ts).
  const canonical = spell.request(owners);
  if (url.search !== canonical) throw redirect(`${url.pathname}${canonical}`);

  // Read once, first: the selection below narrows against this, so nothing may read ahead of it.
  const resolved = await ownerRoster(owners);

  if (resolved.coversEveryone) {
    throw redirect(`${url.pathname}${spell.request(ALL_OWNERS)}`);
  }

  // Filter owners (not map narrowedTo) to keep canonical order; the set of ids is identical either way.
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

// Distinguishes "filter reached nothing" from "instance has nothing" — only the latter may say
// nothing's been uploaded. An unnarrowed screen passes the same count for both, so there's
// nothing for a caller to get wrong. Named to match isFiltered, not narrowedToNothing.
export function isNarrowedToNothing(
  owners: OwnerFilter,
  counts: { held: number; instance: number },
): boolean {
  return isFiltered(owners) && counts.instance > 0 && counts.held === 0;
}
