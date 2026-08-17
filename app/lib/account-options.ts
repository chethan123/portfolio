/**
 * The account kinds and tax treatments, once.
 *
 * Not a `.server` module, deliberately: the domain module needs these values to
 * validate against and the form needs them to render options, and a list
 * written twice is a list free to drift from the schema's check constraints.
 * Everything here is plain data with no database access, so both sides can
 * import it.
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
