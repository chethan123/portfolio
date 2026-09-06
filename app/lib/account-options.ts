// Closed vocabularies (account kinds, tax treatments, asset classes) shared by forms and
// domain validation — one list each, kept in sync with the schema's check constraints by hand.
import type { AccountKind, AssetClass, TaxTreatment } from "./valuation.server.ts";

export type Option<Value extends string> = { readonly value: Value; readonly label: string };

// Must match account_kind_valid in the initial migration.
export const ACCOUNT_KINDS: ReadonlyArray<Option<AccountKind>> = [
  { value: "brokerage", label: "Brokerage" },
  { value: "401k", label: "Workplace plan (401k, 403b)" },
  { value: "ira", label: "IRA" },
  { value: "bank", label: "Bank" },
  { value: "liability", label: "Loan or other liability" },
];

// Three-way, never a boolean — DESIGN.md §4.5.
export const TAX_TREATMENTS: ReadonlyArray<Option<TaxTreatment>> = [
  { value: "taxable", label: "Taxable — tax due on gains" },
  { value: "tax_deferred", label: "Tax-deferred — tax due on withdrawal (Traditional)" },
  { value: "tax_free", label: "Tax-free — no tax on qualified withdrawal (Roth, HSA)" },
];

// Matches classification_asset_class_valid; offered by the upload wizard's instruments step.
export const ASSET_CLASSES: ReadonlyArray<Option<AssetClass>> = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bonds" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

export const accountKindValues = ACCOUNT_KINDS.map((kind) => kind.value) as [
  AccountKind,
  ...AccountKind[],
];

export const taxTreatmentValues = TAX_TREATMENTS.map((treatment) => treatment.value) as [
  TaxTreatment,
  ...TaxTreatment[],
];

// No Zod tuple like the two above: the upload resolver refuses field by field,
// naming every bad field at once, rather than parsing the step as a whole.
export function isAssetClass(value: string | undefined): value is AssetClass {
  return ASSET_CLASSES.some((assetClass) => assetClass.value === value);
}

// Falls back to the raw value rather than throwing, so a row predating a rename still renders.
export function labelOf<Value extends string>(
  options: ReadonlyArray<Option<Value>>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

// Exhaustive record, not a list: adding a kind forces a compile error here instead
// of silently defaulting a new kind to the wrong answer.
const SINGLE_POSITION: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: true,
  liability: true,
};

// Only consulted for kinds SINGLE_POSITION admits; securities accounts never reach it.
const OWES: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: false,
  liability: true,
};

// Lives here, not balances.server.ts, because updateAccount needs it too and can't
// import balances.server.ts (which already imports accounts.server.ts).
export function acceptsSetBalance(kind: AccountKind): boolean {
  return SINGLE_POSITION[kind];
}

// Lets the form caption its box "Amount owed" vs "Balance" to match the sign it will store.
export function isOwed(kind: AccountKind): boolean {
  return OWES[kind];
}
