// Form fields -> domain input, and a refusal -> something a person can read. Shared vocabulary
// (error type, parse helper, field shapes, phrase-builder) so routes never import Zod.
import { z } from "zod";

import {
  moneyMagnitudeRule,
  parseDecimalInput,
  percentRateRule,
  perShareAmountRule,
  signedQuantityRule,
  type DecimalInputRule,
} from "./decimal-input.ts";

// Key for a message belonging to the submission as a whole, not one field.
export const FORM_ERROR = "form";

export type FieldErrors = Readonly<Record<string, string>>;

// A refusal is an ordinary outcome, never a 500.
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly fieldErrors: FieldErrors;

  constructor(fieldErrors: FieldErrors) {
    super(Object.values(fieldErrors).join(" ") || "Invalid input.");
    this.fieldErrors = fieldErrors;
  }

  static form(message: string): ValidationError {
    return new ValidationError({ [FORM_ERROR]: message });
  }
}

// Separate from ValidationError: they become different responses (re-rendered form vs. 404).
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

// "A", "A and B", "A, B and C" — not Intl.ListFormat, which writes a serial comma this prose doesn't.
export function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Bound is storage sanity, not a domain rule — a pasted statement in a name column breaks every list.
export const requiredText = (label: string, max = 200) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `${label} must be ${max} characters or fewer.` });

// Blank -> null, not "": the schema's absent value, and "" vs. no-number distinguishes nothing.
export const optionalText = (label: string, max = 200) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} must be ${max} characters or fewer.` })
    .transform((value) => (value === "" ? null : value))
    .nullish()
    .transform((value) => value ?? null);

// Zod's first path segment is the field name. Only the first message per field survives —
// a box can only carry one.
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
): z.output<Schema> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? FORM_ERROR);
    fieldErrors[field] ??= issue.message;
  }

  throw new ValidationError(fieldErrors);
}

// The split, done once: an element can't pick `form` out itself, since `FORM_ERROR` is a `.server`
// value. Actions are stripped from the client bundle, so this is the right side of the line.
// Spread onto, never conformed to: action payloads don't share one shape (2026-08-23 review §4.5).
export function refused(
  error: ValidationError,
  values: Record<string, string>,
): { errors: FieldErrors; formError: string | null; values: Record<string, string> } {
  const { [FORM_ERROR]: formError, ...errors } = error.fieldErrors;
  return { errors, formError: formError ?? null, values };
}

// File parts dropped, never stringified ("[object File]" helps nobody). Upload reads its file
// from FormData directly.
export function formFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

// Parse and validate once. The same browser-safe rule drives the live interpretation note, so it
// cannot present a sign, scale, size or range that this boundary then refuses.
const decimalText = (rule: DecimalInputRule, required = false) =>
  z
    .string(required ? { message: `${rule.label} is required.` } : undefined)
    .transform((value, ctx) => {
      const parsed = parseDecimalInput(value, rule.options);
      if (parsed.kind === "invalid") {
        ctx.addIssue({ code: "custom", message: rule.message(parsed.reason) });
        return z.NEVER;
      }
      if (required && parsed.value === "") {
        ctx.addIssue({ code: "custom", message: `${rule.label} is required.` });
        return z.NEVER;
      }
      return parsed.value;
    });

// Unsigned decimal string, as a person types one ($14,500.00 / 14,500 / 14500 all valid).
// No sign: direction comes from account kind (§2), not a second source of truth. No Number():
// output stays typed digits as text (§4.1). maxIntegerDigits default 12 = numeric(20,8)'s room.
export const moneyMagnitude = (label: string, maxIntegerDigits = 12) =>
  decimalText(moneyMagnitudeRule(label, maxIntegerDigits), true);

// USD's seeded close is dated 1970-01-01, and holding_valued_at carries closes forward only —
// a set dated earlier is unpriced cash. Exported so a date control's boundary is stated once.
export function earliestRecordableDate(): string {
  return "1970-01-01";
}

// Exported as the date control's max, so the markup hint can't disagree with the refusal below.
export function latestRecordableDate(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

// YYYY-MM-DD. Refuses: not a real calendar date; in the future (a typo'd year pins the account
// via max(as_of_date) with no way to correct it by recording the right one); before
// earliestRecordableDate (also excludes 0000-01-01, which JS accepts and Postgres has no year
// for). Tomorrow only, not further: browser control speaks local, this speaks UTC, so a
// household far enough east is on tomorrow's date honestly.
export const recordedDate = (label: string) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "") {
        refuse(`${label} is required.`);
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        refuse(`${label} must be written as YYYY-MM-DD.`);
        return;
      }

      // Round-trip is the calendar check: 2026-02-30 parses to March 2nd, serialising back differently.
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        refuse(`${label} is not a date on the calendar.`);
        return;
      }

      if (value < earliestRecordableDate()) {
        refuse(
          `${label} is before ${earliestRecordableDate()}, the first day this application can price anything.`,
        );
        return;
      }

      if (value > latestRecordableDate()) {
        refuse(`${label} is in the future, and a balance can only be recorded once it is true.`);
      }
    });

// Signed, unlike moneyMagnitude: this box reopens containing the quantity already on the row
// (e.g. a loan showing "−8,000"), so it must round-trip formatQuantity's output — U+2212 and
// thousands separators both need to come back in. "−0" isn't a thing: a debt of nothing
// shouldn't print as though it were something.
export const signedQuantity = (label: string, maxIntegerDigits = 12) =>
  decimalText(signedQuantityRule(label, maxIntegerDigits), true)
    // After the checks: "−0.00" refused for being zero (normalised), not for its sign.
    .transform((value) => (/^-0+(\.0+)?$/.test(value) ? value.slice(1) : value));

// Unsigned — a price is a positive market fact even for a position held negative (§2). 4 decimal
// places (numeric(20,4)) so a box prefilled from cost_basis_per_share accepts what it printed.
// Blank -> null, never 0: a zero basis would claim the shares were free.
export const perShareAmount = (label: string, maxIntegerDigits = 16) =>
  decimalText(perShareAmountRule(label, maxIntegerDigits))
    .transform((value) => (value === "" ? null : value))
    .nullish()
    .transform((value) => value ?? null);

// Typed, asked, printed and stored as a percentage (23.8, not 0.238) — conversion to a
// multiplier happens only where the multiplying does. "23.8%" pasted equals "23.8" typed;
// negative isn't a generosity extended (a negative rate isn't a rate). No Number() (§4.1).
export const percentRate = (label: string) => decimalText(percentRateRule(label), true);
