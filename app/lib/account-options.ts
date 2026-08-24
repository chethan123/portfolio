/**
 * The account kinds and tax treatments, once.
 *
 * Not a `.server` module, deliberately: the domain module needs these values to
 * validate against and the form needs them to render options, and a list
 * written twice is a list free to drift from the schema's check constraints.
 * Everything here is plain data and pure functions over it, with no database
 * access, so both sides can import it.
 *
 * The `AccountKind` and `TaxTreatment` types are imported for their names only
 * — a type import is erased, so this file pulls no server code into the client
 * bundle.
 */
import type { AccountKind, TaxTreatment } from "./valuation.server.ts";

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
 * The label a stored value wears on screen.
 *
 * Falls back to the value itself rather than throwing: a row written before a
 * kind was renamed should render as the raw slug, which is ugly and legible,
 * rather than taking the page down.
 */
export function labelOf<Value extends string>(
  options: ReadonlyArray<Option<Value>>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Which kinds hold their whole position in one number.
 *
 * An exhaustive record rather than a list or a predicate: adding a kind to the
 * schema becomes a compile error here, at the exact place someone has to decide
 * whether a single `USD` row is the truth about it. A list would just quietly
 * not contain the new kind, and quietly not containing it is the answer that
 * loses a portfolio.
 */
const SINGLE_POSITION: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: true,
  liability: true,
};

/**
 * Which direction a kind's balance runs.
 *
 * Only consulted for the kinds {@link SINGLE_POSITION} admits; the securities
 * accounts are absent from this question because they never reach it.
 */
const OWES: Record<AccountKind, boolean> = {
  brokerage: false,
  "401k": false,
  ira: false,
  bank: false,
  liability: true,
};

/**
 * Can this kind of account have its balance set by hand?
 *
 * Here rather than in `balances.server.ts`, where it was written, because both
 * writers now need it: `setBalance` asks it of the account it is writing to,
 * and `updateAccount` asks it of the kind it is being asked to write. The
 * second cannot import the first: `balances.server.ts` already imports
 * `accounts.server.ts`. The two tables are the kind vocabulary as much as the
 * labels are, so they live with it.
 */
export function acceptsSetBalance(kind: AccountKind): boolean {
  return SINGLE_POSITION[kind];
}

/**
 * Does a balance on this kind count against the household?
 *
 * Exported so the form can caption its box with the direction it is going to
 * apply — "Amount owed" over a box whose contents become a negative quantity.
 * The alternative is a screen that says "Balance" and stores the opposite of
 * what a reader would expect, which is a lie told by omission.
 */
export function isOwed(kind: AccountKind): boolean {
  return OWES[kind];
}
