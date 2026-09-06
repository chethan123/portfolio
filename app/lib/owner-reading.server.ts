// Owner-filter reading (spec 0013, ADR-0008): the one place that turns ?owner= into what a screen
// may believe it means. Every return is settled: url.search === address.request(owners), and
// resolved.coversEveryone is false. Reads no money — a whole-household read says ALL_OWNERS at its
// own call site. `reading` resolves against the roster, never raw ids, because holding_valued_at
// admits accounts closed after the date asked about; it never widens (`[]` only when owners is `[]`).
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
