// Account picker labels, grouped by owner: escalate only on collision — name+tail,
// then "— institution · kind", then "· tax treatment" (DESIGN.md §5.1's Traditional/Roth case).
// Still-identical rows stay identical; group/option order follows the People screen.
import { ACCOUNT_KINDS, TAX_TREATMENTS, labelOf } from "./account-options.ts";

import type { AccountKind, TaxTreatment } from "./valuation.server.ts";

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

export function numberTailCharacters(externalAccountNumber: string | null): string | null {
  const trimmed = externalAccountNumber?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(-4);
}

// Numbers are stored bare and free-form (e.g. "X47-283910"), so the tail is characters, not digits.
export function numberTail(externalAccountNumber: string | null): string | null {
  const characters = numberTailCharacters(externalAccountNumber);
  return characters === null ? null : `····${characters}`;
}

// Derives from TAX_TREATMENTS rather than a second label list: text before the
// em-dash plus any trailing parenthetical, e.g. "Tax-deferred (Traditional)".
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
  // Institution may be blank; kind label never is, so facts is never empty.
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

  // Ordered by name (as the People screen orders people); id tie-break is a numeric
  // compare (length then text) without Number() on the bigint id string.
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
