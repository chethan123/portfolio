/**
 * Turning a submitted form into domain input, and a refusal into something a
 * person can read.
 *
 * The domain modules own their own rules — `people.server.ts` decides what a
 * name is — and this module is only the shared vocabulary they express those
 * rules in: one error type carrying per-field messages, one parse helper, the
 * field shapes the forms are built from — two of text, one of money and one of
 * dates — and the one phrase-builder their refusals share, so that three
 * modules naming a list of things name it the same way.
 *
 * It exists so that a route never has to know about Zod. A route reads the
 * form, hands the raw fields to a domain function and renders whatever comes
 * back on the way out; that is what keeps the routes thin wrappers rather than
 * a second place the rules live.
 */
import { z } from "zod";

import { SHARE_SCALE, compareDecimal } from "./money.ts";

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
 * "A", "A and B", "A, B and C" — a refusal reads as a sentence, not a dump.
 *
 * Here rather than beside any one of the three refusals that name a list,
 * because they are three ways of saying the same thing to the same reader and a
 * second copy would be free to punctuate it differently. Not `Intl.ListFormat`,
 * which writes the serial comma none of the prose in this application does.
 */
export function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
 * The digits and the point, extracted from the way a person writes a figure.
 *
 * Shared by all three number fields — {@link moneyMagnitude},
 * {@link signedQuantity} and {@link perShareAmount} — because all three are
 * copied off the same statements, and a second, subtly different set of strip
 * rules would be a second answer to "is `1 234.5` a number". It was two copies
 * for a while, and the lone-point bug below was in both of them — which is the
 * argument for one: a fault found in one box is fixed for every box.
 */
const bareDecimal = (value: string): string =>
  value
    .replace(/^\+/, "")
    // U+00A0 is what a copy out of a rendered statement brings with it, and
    // U+2009 is the thin space some brokerages group thousands with.
    .replace(/[$\s ,]/g, "")
    // ".50" and "50." are unambiguous, so they are completed rather than
    // refused. Every other shape has to be exactly right — and the lookarounds
    // are what keep a bare "." out of that generosity. Without them the two
    // rules compose: "." becomes "0." becomes "0", and a stray keystroke is
    // accepted as a figure of zero. On a quantity that reads as the whole
    // position sold; on a balance it empties an account.
    .replace(/^\.(?=\d)/, "0.")
    .replace(/(?<=\d)\.$/, "");

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
    .transform(bareDecimal)
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
 * The earliest date {@link recordedDate} will accept.
 *
 * `1970-01-01` rather than an arbitrary round year, because that is the first
 * day this application can put a price on anything: `0001_initial_schema.sql`
 * seeds USD a close of `1.00` dated `1970-01-01`, and `holding_valued_at`
 * carries the last close *forward* only. A set dated before that row produces a
 * chart point on which even cash is unpriced.
 *
 * Exported alongside {@link latestRecordableDate} so a date control can carry
 * both boundaries, for the same reason: the rule is stated once and read twice.
 */
export function earliestRecordableDate(): string {
  return "1970-01-01";
}

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
 * Three refusals, each earning its place:
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
 * **A date before this application can price anything.** The ceiling had no
 * floor, so `1026-08-24` — one digit away from `2026-08-24` — recorded a
 * position set a thousand years back and permanently flattened the "All"
 * net-worth chart, with no way to reach the row and correct it. The floor is
 * {@link earliestRecordableDate}, and it also disposes of `0000-01-01`, which
 * has a year zero in JavaScript, passes the round trip above, and then reaches
 * the family as a driver error because Postgres has no year zero.
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

/** What `numeric(20, 8)` keeps after the point. */
const QUANTITY_DECIMALS = 8;

/** What `numeric(20, 4)` keeps after the point. */
const PER_SHARE_DECIMALS = 4;

/**
 * A quantity held, as a **signed** decimal string at `numeric(20, 8)`'s scale.
 *
 * The opposite decision to {@link moneyMagnitude}'s, and the difference is the
 * whole reason both exist. `moneyMagnitude` serves a form that asks "what is
 * the balance?" of an account whose direction is known from its kind (§2), so
 * accepting a sign there would give the app two sources of truth for whether
 * money is owed. This one serves a box that opens *containing the quantity
 * already on the row* — a loan reads `−8,000` in the table and reads `−8,000`
 * in the box, and the reader edits the digits around a minus sign that was
 * already there. Stripping the sign out to re-derive it would mean printing a
 * number the screen has never shown.
 *
 * That makes round-tripping `formatQuantity`'s output a hard requirement rather
 * than a nicety: the box is prefilled with it, so U+2212 (the true minus the
 * table prints) and the thousands separators must both come back in.
 *
 * **`−0` is not a thing.** A negative zero is a debt of nothing written as
 * though it were something, exactly as `setBalance` says of the same figure,
 * and it would print as `−0` in the table.
 *
 * @param label how the quantity is named in a refusal, e.g. "A quantity".
 * @param maxIntegerDigits digits before the point. Defaults to 12, which is
 *        what `numeric(20, 8)` has room for once the scale is taken out.
 */
export const signedQuantity = (label: string, maxIntegerDigits = 12) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    // U+2212 in, ASCII out: the table prints a true minus and the driver takes
    // a hyphen, so the conversion happens once, here, rather than at the edge
    // of every caller.
    .transform((value) => bareDecimal(value).replace(/^−/, "-"))
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "" || value === "-") {
        refuse(`${label} is required.`);
      } else if (!/^-?\d+(\.\d+)?$/.test(value)) {
        refuse(`${label} must be a number, like 120.5 — or −8,000 for something owed.`);
      } else if ((value.split(".")[1] ?? "").length > QUANTITY_DECIMALS) {
        refuse(
          `${label} is recorded to ${QUANTITY_DECIMALS} decimal places, which is finer than any ` +
            "brokerage reports a fractional share.",
        );
      } else if (
        (value.split(".")[0] ?? "").replace(/^-/, "").replace(/^0+/, "").length > maxIntegerDigits
      ) {
        refuse(`${label} is larger than this application can store.`);
      }
    })
    // After the checks, so that "−0.00" is refused for nothing and normalised
    // rather than being refused for its sign.
    .transform((value) => (/^-0+(\.0+)?$/.test(value) ? value.slice(1) : value));

/**
 * What one share cost, where blank means "the statement did not say".
 *
 * Unsigned, because a price is a positive market fact even for a position held
 * negative (§2) — the sign lives in the quantity it multiplies.
 *
 * Four decimal places rather than {@link moneyMagnitude}'s two, because
 * `holding.cost_basis_per_share` is `numeric(20, 4)` and a box prefilled from
 * that column must accept what it was prefilled with. A two-place rule here
 * would refuse `31.4159` on a resubmit having just printed it.
 *
 * Blank becomes `null`, never `0`: a cost basis of zero claims the shares were
 * free and prints an unrealized gain equal to the whole position, which is the
 * exact reading `valuation.server.ts` refuses everywhere else.
 *
 * @param label how the figure is named in a refusal, e.g. "A cost basis".
 */
export const perShareAmount = (label: string, maxIntegerDigits = 16) =>
  z
    .string()
    .trim()
    .transform(bareDecimal)
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "") return;

      if (/^[-−]/.test(value)) {
        refuse(
          `${label} is what one share cost, which is never negative — a position held short or ` +
            "owed carries its sign in the quantity instead.",
        );
      } else if (!/^\d+(\.\d+)?$/.test(value)) {
        refuse(`${label} must be an amount in dollars, like 92.4150.`);
      } else if ((value.split(".")[1] ?? "").length > PER_SHARE_DECIMALS) {
        refuse(`${label} is recorded to ${PER_SHARE_DECIMALS} decimal places, and no further.`);
      } else if ((value.split(".")[0] ?? "").replace(/^0+/, "").length > maxIntegerDigits) {
        refuse(`${label} is larger than this application can store.`);
      }
    })
    .transform((value) => (value === "" ? null : value))
    .nullish()
    .transform((value) => value ?? null);

/**
 * A tax rate, typed as a percentage — `23.8`, not `0.238`.
 *
 * A percentage is what a person says out loud, what the form asks for and what
 * the panel it feeds prints beside its column heading, so it is what the field
 * takes and what the column stores. The one conversion to a multiplier lives
 * where the multiplying happens, rather than at every boundary this figure
 * crosses.
 *
 * `bareDecimal` again, so `23.8%` pasted out of a tax table is the same figure
 * as `23.8` typed by hand — the sign is the only generosity withheld, because a
 * negative rate is not a rate.
 *
 * **No `Number`.** The output is the digits, like every other figure that ends
 * up multiplying money (§4.1).
 *
 * @param label how the rate is named in a refusal, e.g. "A tax rate".
 * @param decimals places allowed after the point. Defaults to the share scale,
 *        which is what the column stores and finer than anyone will type.
 */
export const percentRate = (label: string, decimals = SHARE_SCALE) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .transform((value) => bareDecimal(value.replace(/%$/, "")))
    .superRefine((value, ctx) => {
      const refuse = (message: string) => ctx.addIssue({ code: "custom", message });

      if (value === "") {
        refuse(`${label} is required.`);
      } else if (/^[-−]/.test(value)) {
        refuse(`${label} cannot be negative.`);
      } else if (!/^\d+(\.\d+)?$/.test(value)) {
        refuse(`${label} must be a percentage, like 23.8.`);
      } else if ((value.split(".")[1] ?? "").length > decimals) {
        refuse(`${label} takes at most ${decimals} decimal places.`);
      } else if (compareDecimal(value, "100", decimals) > 0) {
        // Compared on the digits rather than through `Number(value) > 100`,
        // which is the same float this module keeps every other figure out of.
        refuse(`${label} cannot be more than 100%.`);
      }
    });
