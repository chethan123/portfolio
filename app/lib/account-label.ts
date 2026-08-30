/**
 * The upload screen's account labels — grouped by owner, quiet until two
 * rows would read the same. Names usually carry the facts already ("Vanguard
 * Roth IRA"), and a native <option> has no muted secondary text — but a name
 * is free text with no uniqueness constraint, so the picker must still tell
 * identically-named accounts apart. The rule: a row says more only when
 * saying less would make it a twin.
 *
 *   1. The account's name, plus ····last-4 of the recorded account number
 *      when there is one — the one part a name never carries.
 *   2. Twins within their owner's group append "— institution · type".
 *   3. Still twins append the tax treatment, shortened — the stored fact
 *      separating a Traditional from a Roth (DESIGN.md §5.1's collision).
 *
 * Then the chain stops: rows identical in every stored attribute render
 * identically, honestly — telling them apart is a rename in Settings.
 * Grouped by owner because that is the collision the picker actually
 * suffered (two people, one broker); groups follow the People screen's
 * order, options keep the account list's own (ingest brief §3). Pure on
 * purpose: no test in this repo imports a route, so the screen's one piece
 * with rules in it lives where every collision tier is a fixture.
 */
import { ACCOUNT_KINDS, TAX_TREATMENTS, labelOf } from "./account-options.ts";

import type { AccountKind, TaxTreatment } from "./valuation.server.ts";

/** What a label needs to know about one account; a subset of `Account`. */
export type PickerAccount = {
  id: string;
  name: string;
  institution: string;
  kind: AccountKind;
  taxTreatment: TaxTreatment;
  ownerId: string;
  ownerName: string;
  externalAccountNumber: string | null;
};

export type PickerOption = { id: string; label: string };

export type PickerGroup = { ownerId: string; ownerName: string; options: PickerOption[] };

/**
 * `····2245` from the stored number's last four characters, or null without
 * one. Stored bare and free-form (`X47-283910` is real), so the tail is
 * characters, not digits, and the mask glyphs belong to the renderer, never
 * the stored value.
 */
export function numberTail(externalAccountNumber: string | null): string | null {
  const trimmed = externalAccountNumber?.trim() ?? "";
  return trimmed === "" ? null : `····${trimmed.slice(-4)}`;
}

/**
 * "Tax-deferred — tax due on withdrawal (Traditional)" → "Tax-deferred
 * (Traditional)". Derived, not written twice: `TAX_TREATMENTS` stays the
 * single source, and the shortening is mechanical — the part before the
 * em-dash plus any trailing parenthetical.
 */
function shortTaxLabel(treatment: TaxTreatment): string {
  const label = labelOf(TAX_TREATMENTS, treatment);
  const head = label.split(" — ")[0] ?? label;
  const parenthetical = /\(([^)]*)\)\s*$/.exec(label);
  return parenthetical ? `${head} (${parenthetical[1]})` : head;
}

function baseLabel(account: PickerAccount): string {
  const tail = numberTail(account.externalAccountNumber);
  return tail === null ? account.name : `${account.name} ${tail}`;
}

function enrichedLabel(account: PickerAccount): string {
  // Institution can be the empty string (the form allows a blank); the kind
  // label never is, so the facts clause never comes out empty.
  const facts = [account.institution, labelOf(ACCOUNT_KINDS, account.kind)]
    .filter((part) => part !== "")
    .join(" · ");
  return `${baseLabel(account)} — ${facts}`;
}

function fullLabel(account: PickerAccount): string {
  return `${enrichedLabel(account)} · ${shortTaxLabel(account.taxTreatment)}`;
}

function counts(labels: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  return seen;
}

export function accountPickerGroups(accounts: PickerAccount[]): PickerGroup[] {
  const groups = new Map<string, { ownerName: string; members: PickerAccount[] }>();
  for (const account of accounts) {
    const group = groups.get(account.ownerId) ?? { ownerName: account.ownerName, members: [] };
    group.members.push(account);
    groups.set(account.ownerId, group);
  }

  // Person-name order, as the People screen orders people. Ids tie-break by
  // length then text — a numeric compare without `Number()` on a bigint
  // string. Two people may genuinely share a name; they stay two groups.
  const ordered = [...groups.entries()].sort(
    ([aId, a], [bId, b]) =>
      a.ownerName.localeCompare(b.ownerName) || aId.length - bId.length || aId.localeCompare(bId),
  );

  return ordered.map(([ownerId, { ownerName, members }]) => {
    const withBase = members.map((member) => ({ member, base: baseLabel(member) }));
    const baseCounts = counts(withBase.map((entry) => entry.base));

    const withEnriched = withBase.map((entry) => ({
      ...entry,
      label: (baseCounts.get(entry.base) ?? 0) > 1 ? enrichedLabel(entry.member) : entry.base,
    }));
    const enrichedCounts = counts(withEnriched.map((entry) => entry.label));

    const options = withEnriched.map(({ member, base, label }) => ({
      id: member.id,
      label:
        label !== base && (enrichedCounts.get(label) ?? 0) > 1 ? fullLabel(member) : label,
    }));

    return { ownerId, ownerName, options };
  });
}
