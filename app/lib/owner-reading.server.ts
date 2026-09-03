/**
 * The owner-filter reading (spec 0013, ADR-0008): the one place that
 * turns the URL's `?owner=` into what a screen is allowed to believe it means.
 * Four screens — Analysis, Income, Overview, Holdings — used to spell this
 * settling themselves, in near-identical loader preambles that had already
 * begun to drift (Overview alone reordered two synchronous reads around the
 * roster query; Holdings alone dropped `saved` on its everyone bounce, where
 * its own canonical bounce keeps it). One function now speaks it once.
 *
 * `.server.ts`, because it value-imports `ownerRoster` from `people.server.ts`.
 * Its counterpart `owner-filter.ts` stays plain: the control component
 * re-renders after hydration and needs that module's vocabulary; nothing in
 * the browser needs this one's protocol.
 *
 * `ownerReading(request, address?)`, in order:
 *
 * 1. reads the filter off the request's own URL;
 * 2. bounces to the canonical spelling of that address, before any database
 *    work — the canonical spelling is a fact about the address, decidable
 *    without asking who exists;
 * 3. reads the roster once, alone — `ownerRoster`'s one query, ahead of
 *    everything else a screen reads, because step 5 is a function of it;
 * 4. bounces a selection naming everybody to the household's own address —
 *    the household's spelling carries no owner parameter at all (ADR-0008),
 *    and a `<Form method="get">` of checkboxes cannot decline to submit that
 *    spelling, so the collapse happens here, after the roster read it needs;
 * 5. resolves `reading` — what every household-scoped reader on the calling
 *    screen narrows by, from the selection **resolved against the roster**,
 *    never the raw ids (see below); and
 * 6. projects the roster, the narrowed selection and `unknownOwner` into the
 *    owner block of a loader's payload, ready to spread into its return.
 *
 * **Why the module does not read money.** ADR-0008 buys one property: a
 * screen reading the whole household says `ALL_OWNERS` where a reviewer sees
 * it. A module that called `currentHoldings` for its caller would spend
 * that — the call would be here, not at the screen, and a reviewer would have
 * to already know this module's insides to see whose money a loader reads.
 * So the household-scoped reads stay in the loader, visible and explicit,
 * and `ownerReading` cannot be skipped or reordered ahead of them: `reading`
 * does not exist until this resolves, which makes the ordering a data
 * dependency rather than a convention a loader could quietly drop. One row
 * of the ticket's table therefore stays open by design: whether the
 * *instance* holds anything (`isFiltered(owners) ? netWorth(ALL_OWNERS) :
 * null`) is a money read, so it stays spelled in each loader.
 *
 * The chart's reads (spec 0015) are made by `chart-series.server.ts` rather
 * than by the loader, and they do not spend that property: the loader
 * constructs the scope naming `reading` and hands it over on the call line,
 * so what a reviewer reads is still the screen saying whose money it wants.
 * That is the difference from this module doing it — here `reading` is
 * already in hand and would be used silently.
 *
 * **Why `reading`, not the raw filter.** `holding_valued_at` reads an account
 * closed *after* the date it is asked about, so a stale id in a hand-typed
 * address would put that owner's past into a chart or a delta while the
 * sentence beside it named only the others (DESIGN.md §14). Resolving the
 * selection against the roster first is what keeps a since-removed or
 * since-closed id from reaching a reader that spans dates. A selection
 * resolving to *nobody* keeps the raw ids, which narrow to nothing — `[]`
 * would read the whole household, the exact widening `owner-filter.ts`
 * forbids.
 *
 * **Invariants**, on every return:
 * 1. The address is settled: `url.search === address.request(owners)` and
 *    `resolved.coversEveryone` is false.
 * 2. `isFiltered(owners) === isFiltered(reading)`, always — so a caller never
 *    has to decide which of the two a predicate wants.
 * 3. `reading` is `[]` only when `owners` is `[]`. It never widens.
 * 4. At most two hops out of the loader: the spelling, then the collapse.
 * 5. Every field of `OwnerBlock` is plain data — nothing has to be stripped
 *    before it crosses into a loader's return.
 */
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
