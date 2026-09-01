/**
 * The closed vocabularies a form offers and the domain validates — account
 * kinds, tax treatments, asset classes — once each. Not a `.server` module,
 * deliberately: the domain module validates against these values and the
 * form renders options from them, and a list written twice is free to drift
 * from the schema's check constraints (`account_kind_valid`,
 * `tax_treatment_valid`, `classification_asset_class_valid`). Plain data and
 * pure functions, no database. The type imports are erased, so this pulls no
 * server code into the client bundle.
 *
 * The name says accounts because accounts came first; what the module owns is
 * the vocabulary, whatever a value is stored against.
 */
import type { AccountKind, AssetClass, TaxTreatment } from "./valuation.server.ts";

/** A stored value and the label a person reads for it. */
export type Option<Value extends string> = { readonly value: Value; readonly label: string };

/**
 * The values match `account_kind_valid` in the initial migration exactly.
 * Adding a kind is a migration plus a line here, in that order.
 */
export const ACCOUNT_KINDS: ReadonlyArray<Option<AccountKind>> = [
  { value: "brokerage", label: "Brokerage" },
  { value: "401k", label: "Workplace plan (401k, 403b)" },
  { value: "ira", label: "IRA" },
  { value: "bank", label: "Bank" },
  { value: "liability", label: "Loan or other liability" },
];

/**
 * Three-way, never a boolean (DESIGN.md §4.5) — the labels say what each one
 * means for a figure, because that distinction is the entire reason the column
 * is not a boolean.
 */
export const TAX_TREATMENTS: ReadonlyArray<Option<TaxTreatment>> = [
  { value: "taxable", label: "Taxable — tax due on gains" },
  { value: "tax_deferred", label: "Tax-deferred — tax due on withdrawal (Traditional)" },
  { value: "tax_free", label: "Tax-free — no tax on qualified withdrawal (Roth, HSA)" },
];

/**
 * The four-way rollup every classification maps onto (CONTEXT.md). Its values
 * match `classification_asset_class_valid`; unlike its two neighbours nothing
 * renders it in an account form, but the upload wizard's classification step
 * offers exactly these and the resolver refuses anything else.
 */
export const ASSET_CLASSES: ReadonlyArray<Option<AssetClass>> = [
  { value: "equity", label: "Equity" },
  { value: "bond", label: "Bonds" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

/** The stored values alone, in the shape Zod's `enum` wants. */
export const accountKindValues = ACCOUNT_KINDS.map((kind) => kind.value) as [
  AccountKind,
  ...AccountKind[],
];

export const taxTreatmentValues = TAX_TREATMENTS.map((treatment) => treatment.value) as [
  TaxTreatment,
  ...TaxTreatment[],
];

/**
 * The asset classes' stored values alone. A plain list, not the tuple above:
 * its one caller asks whether a posted string is one of them, and the upload
 * resolver refuses field by field rather than parsing with Zod.
 */
export const assetClassValues: ReadonlyArray<AssetClass> = ASSET_CLASSES.map(
  (assetClass) => assetClass.value,
);

/**
 * The label a stored value wears on screen. Falls back to the value itself
 * rather than throwing: a row written before a kind was renamed renders as
 * the raw slug — ugly and legible — rather than taking the page down.
 */
export function labelOf<Value extends string>(
  options: ReadonlyArray<Option<Value>>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Which kinds hold their whole position in one number. An exhaustive record,
 * not a list or predicate: adding a kind to the schema becomes a compile
 * error here, exactly where someone must decide whether a single `USD` row
 * is the truth about it — a list would quietly not contain the new kind,
 * and quietly not containing it is the answer that loses a portfolio.
 */
const SINGLE_POSITION: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: true,
  liability: true,
};

/**
 * Which direction a kind's balance runs. Only consulted for the kinds
 * {@link SINGLE_POSITION} admits; securities accounts never reach it.
 */
const OWES: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: false,
  liability: true,
};

/**
 * Can this kind's balance be set by hand? Here rather than in
 * `balances.server.ts`, where it was written, because both writers need it:
 * `setBalance` asks it of the account, `updateAccount` of the kind — and the
 * second cannot import the first (`balances.server.ts` already imports
 * `accounts.server.ts`). The two tables are the kind vocabulary as much as
 * the labels are.
 */
export function acceptsSetBalance(kind: AccountKind): boolean {
  return SINGLE_POSITION[kind];
}

/**
 * Does a balance on this kind count against the household? Exported so the
 * form can caption its box with the direction it will apply — "Amount owed"
 * over a box whose contents become a negative quantity; a screen saying
 * "Balance" while storing the opposite is a lie told by omission.
 */
export function isOwed(kind: AccountKind): boolean {
  return OWES[kind];
}
