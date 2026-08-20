/**
 * Turning a submitted form into domain input, and a refusal into something a
 * person can read.
 *
 * The domain modules own their own rules — `people.server.ts` decides what a
 * name is — and this module is only the shared vocabulary they express those
 * rules in: one error type carrying per-field messages, one parse helper, and
 * the field shapes the forms are built from — two of text, one of money and one
 * of dates.
 *
 * It exists so that a route never has to know about Zod. A route reads the
 * form, hands the raw fields to a domain function and renders whatever comes
 * back on the way out; that is what keeps the routes thin wrappers rather than
 * a second place the rules live.
 */
import { z } from "zod";

/**
 * The field name a message belongs to when it belongs to no single field —
 * "this person still owns two accounts" is about the submission, not about a
 * box on the form.
 */
export const FORM_ERROR = "form";

/** Messages keyed by the form field they belong to. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * Input a domain module refused, with a message per field.
 *
 * Carrying the field name is what lets the form re-render with the message
 * beside the box that caused it while every other box keeps what was typed.
 * A refusal is an ordinary outcome of a form submission — never a 500.
 */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly fieldErrors: FieldErrors;

  constructor(fieldErrors: FieldErrors) {
    super(Object.values(fieldErrors).join(" ") || "Invalid input.");
    this.fieldErrors = fieldErrors;
  }

  /** A refusal that belongs to the submission as a whole. */
  static form(message: string): ValidationError {
    return new ValidationError({ [FORM_ERROR]: message });
  }
}

/**
 * An id in a URL or a form that matches no row.
 *
 * Separate from {@link ValidationError} because the two become different
 * responses: a validation failure re-renders the form, a missing row is a 404.
 */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/**
 * Required free text: trimmed, non-empty, and bounded.
 *
 * The bound is a storage sanity limit rather than a domain rule — `text` in
 * Postgres has no length limit, so without one a paste of an entire statement
 * lands in a name column and every list on the screen breaks.
 */
export const requiredText = (label: string, max = 200) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `${label} must be ${max} characters or fewer.` });

/**
 * Optional free text, where blank means "not recorded".
 *
 * Blank becomes `null` rather than `""`: a column that distinguishes "no
 * account number" from "an account number that is the empty string" would be
 * distinguishing nothing, and null is what the schema already means by absent.
 */
export const optionalText = (label: string, max = 200) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} must be ${max} characters or fewer.` })
    .transform((value) => (value === "" ? null : value))
    .nullish()
    .transform((value) => value ?? null);

/**
 * Parse raw form fields against a schema, or refuse with per-field messages.
 *
 * Zod reports an issue path; the first segment is the field name, which is
 * exactly the key the form needs to put the message under. Only the first
 * message per field survives, because a box can only carry one.
 *
 * @throws {ValidationError} naming every field that was wrong.
 */
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

/**
 * The string fields of a submitted form.
 *
 * File parts are dropped rather than stringified — the settings forms have
 * none, and `"[object File]"` reaching a name column is not a failure anyone
 * should have to diagnose. The upload slice reads its file from the `FormData`
 * directly.
 */
export function formFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

/**
 * An amount of money, typed the way a person types one, as an unsigned decimal
 * string.
 *
 * `$14,500.00`, `14,500`, `14500.00` and `14500` are one amount written four
 * ways, and refusing three of them would be refusing the way statements print
 * the number being copied. The currency mark, the thousands separators and the
 * spaces come out; the digits and the point are all that is kept.
 *
 * **No sign.** The caller decides the direction from what the account *is*
 * (DESIGN.md §2 puts the sign in quantity), so a minus typed here is refused
 * rather than honoured — a form that accepts both a signed amount and a
 * kind-derived sign has two sources of truth for whether money is owed, and
 * they can disagree.
 *
 * **No `Number`.** The output is the digits that were typed, normalised as
 * text, because §4.1 keeps money out of floats end to end. `z.coerce.number`
 * would undo the whole discipline in one call.
 *
 * @param label how the amount is named in a refusal, e.g. "A balance".
 * @param maxIntegerDigits digits before the point. Defaults to 12, which is
 *        what `numeric(20, 8)` has room for once the scale is taken out.
 */
export const moneyMagnitude = (label: string, maxIntegerDigits = 12) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .transform((value) =>
      value
        .replace(/^\+/, "")
        // U+00A0 is what a copy out of a rendered statement brings with it.
        .replace(/[$\s ,]/g, "")
        // ".50" and "50." are unambiguous, so they are completed rather than
        // refused. Every other shape has to be exactly right.
        .replace(/^\./, "0.")
        .replace(/\.$/, ""),
    )
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "") {
        refuse(`${label} is required.`);
      } else if (/^[-−]/.test(value)) {
        refuse(
          `${label} is entered as a plain amount, without a minus sign — ` +
            "whether it counts for or against you follows from the kind of account it is.",
        );
      } else if (!/^\d+(\.\d+)?$/.test(value)) {
        refuse(`${label} must be an amount in dollars, like 1,250.00.`);
      } else if ((value.split(".")[1] ?? "").length > 2) {
        refuse(`${label} is recorded to the cent, so it takes at most two decimal places.`);
      } else if ((value.split(".")[0] ?? "").replace(/^0+/, "").length > maxIntegerDigits) {
        refuse(`${label} is larger than this application can store.`);
      }
    });

/**
 * The furthest-ahead date {@link recordedDate} will accept.
 *
 * Exported so a date control can carry the same boundary as its `max`. The rule
 * is stated once and read twice, rather than a hint in the markup quietly
 * disagreeing with the refusal behind it.
 */
export function latestRecordableDate(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A date something was true on, as `YYYY-MM-DD`.
 *
 * Two refusals, each earning its place:
 *
 * **A date that does not exist.** `2026-02-30` is a real thing to type and
 * Postgres would reject it as a `date`, which reaches the family as a driver
 * error rather than a sentence.
 *
 * **A date in the future.** This is the one that matters. "Latest" is
 * `max(as_of_date)` per account (`latest_position_set`), so a year typed as
 * 2126 does not merely record a wrong date — it pins the account to that row
 * and no later statement can outrank it until 2126. A mistyped digit becomes a
 * balance that cannot be corrected by recording the right one.
 *
 * Tomorrow is allowed, and only tomorrow. The browser's date control speaks the
 * reader's local date while everything here speaks UTC (§4.1), so a household
 * far enough east is on tomorrow's date honestly. One day of slack covers every
 * real timezone; two would start covering typos.
 *
 * @param label how the date is named in a refusal, e.g. "The date".
 */
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

      // Round-tripping is the calendar check: `2026-02-30` parses to March 2nd
      // and serialises back as a different string.
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        refuse(`${label} is not a date on the calendar.`);
        return;
      }

      if (value > latestRecordableDate()) {
        refuse(`${label} is in the future, and a balance can only be recorded once it is true.`);
      }
    });
