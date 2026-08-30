/**
 * The upload screen's account labels — grouped by owner, quiet until two rows
 * would read the same.
 *
 * A household's account names usually carry the facts already ("Vanguard Roth
 * IRA"), so a label that always restates institution and type says everything
 * twice — inside a native <option>, where there is no muted secondary text and
 * every character gets equal weight. But a name is free text with no
 * uniqueness constraint anywhere, so the picker must still tell apart two
 * accounts the household named identically. The rule: a row says more only
 * when saying less would make it a twin.
 *
 *   1. Every option is the account's name, plus ····last-4 of the recorded
 *      account number when there is one — the one part a name never carries.
 *   2. Rows that still read the same within their owner's group append
 *      "— institution · account type".
 *   3. Rows that still read the same after that append the tax treatment,
 *      shortened — the one stored fact separating a Traditional from a Roth
 *      held at the same firm under the same name (DESIGN.md §5.1's collision
 *      example).
 *
 * After that the chain stops: rows identical in every stored attribute render
 * identically, honestly. Telling them apart is a rename in Settings, not a
 * label's job.
 *
 * Grouping is by owner because that is the collision the picker actually
 * suffered — two people, one broker — and a group header says the owner once
 * instead of stamping it on every row. Groups follow the People screen's
 * order (name, then id); options keep the order they arrive in, which is the
 * account list's own (ingest brief §3: as Settings orders them).
 *
 * Pure on purpose: no test in this repo imports a route, so the one piece of
 * this screen that has rules in it lives here, where every collision tier is
 * a fixture.
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
 * one. The number is stored bare and free-form (`X47-283910` is real), so the
 * tail is characters, not digits, and the mask glyphs belong to the renderer
 * — never to the stored value.
 */
export function numberTail(externalAccountNumber: string | null): string | null {
  const trimmed = externalAccountNumber?.trim() ?? "";
  return trimmed === "" ? null : `····${trimmed.slice(-4)}`;
}

/**
 * "Tax-deferred — tax due on withdrawal (Traditional)" → "Tax-deferred
 * (Traditional)". Derived, not written twice: the canonical labels in
 * `TAX_TREATMENTS` stay the single source, and the shortening is mechanical —
 * the part before the em-dash, plus the trailing parenthetical when the label
 * has one.
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
