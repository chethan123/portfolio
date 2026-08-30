/**
 * Turning a submitted form into domain input, and a refusal into something a
 * person can read. The domain modules own their rules; this is the shared
 * vocabulary they express them in — one error type with per-field messages,
 * one parse helper, the field shapes the forms are built from, and the one
 * phrase-builder their refusals share. It exists so a route never has to know
 * about Zod: routes stay thin wrappers, not a second place the rules live.
 */
import { z } from "zod";

import { SHARE_SCALE, compareDecimal } from "./money.ts";

/**
 * The key for a message that belongs to no single field — "this person still
 * owns two accounts" is about the submission, not a box.
 */
export const FORM_ERROR = "form";

/** Messages keyed by the form field they belong to. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * Input a domain module refused, a message per field — the field name lets
 * the form re-render the message beside the box that caused it. A refusal is
 * an ordinary outcome of a submission, never a 500.
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
 * An id that matches no row. Separate from {@link ValidationError} because
 * they become different responses: a re-rendered form versus a 404.
 */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/**
 * "A", "A and B", "A, B and C" — a refusal reads as a sentence. Here so the
 * three refusals that name a list cannot punctuate it differently. Not
 * `Intl.ListFormat`, which writes the serial comma this prose does not.
 */
export function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Required free text: trimmed, non-empty, bounded. The bound is storage
 * sanity, not a domain rule — `text` has no limit, and a pasted statement in
 * a name column breaks every list on screen.
 */
export const requiredText = (label: string, max = 200) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `${label} must be ${max} characters or fewer.` });

/**
 * Optional free text, where blank means "not recorded". Blank becomes `null`,
 * not `""`: distinguishing "no number" from "empty-string number" would
 * distinguish nothing, and null is what the schema means by absent.
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
 * Parse raw form fields against a schema, or refuse per field. Zod's first
 * path segment is the field name — exactly the key the form needs. Only the
 * first message per field survives: a box can only carry one.
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
 * The string fields of a submitted form. File parts are dropped, never
 * stringified: `"[object File]"` in a name column is not a failure anyone
 * should diagnose. The upload slice reads its file from `FormData` directly.
 */
export function formFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

/**
 * The digits and the point, extracted from how a person writes a figure.
 * Shared by all three number fields: a second, subtly different strip rule
 * would be a second answer to "is `1 234.5` a number". It was two copies for
 * a while, and the lone-point bug below was in both.
 */
const bareDecimal = (value: string): string =>
  value
    .replace(/^\+/, "")
    // U+00A0 is what a copy out of a rendered statement brings with it, and
    // U+2009 is the thin space some brokerages group thousands with.
    .replace(/[$\s ,]/g, "")
    // ".50" and "50." are unambiguous, so completed rather than refused; the
    // lookarounds keep a bare "." out of that generosity — without them "."
    // becomes "0", and a stray keystroke reads as the whole position sold, or
    // an emptied account.
    .replace(/^\.(?=\d)/, "0.")
    .replace(/(?<=\d)\.$/, "");

/**
 * An amount of money as a person types one, as an unsigned decimal string:
 * `$14,500.00`, `14,500` and `14500` are one amount, and refusing any would
 * refuse the way statements print the number being copied.
 *
 * **No sign** — the caller derives direction from what the account *is* (§2
 * puts the sign in quantity), and a form accepting both a signed amount and
 * a kind-derived sign has two sources of truth that can disagree. **No
 * `Number`** — the output is the typed digits normalised as text (§4.1);
 * `z.coerce.number` would undo the whole discipline in one call.
 *
 * @param label how the amount is named in a refusal, e.g. "A balance".
 * @param maxIntegerDigits before the point; 12 is `numeric(20, 8)`'s room.
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
 * The earliest date {@link recordedDate} accepts: `1970-01-01`, the first day
 * this application can price anything — `0001_initial_schema.sql` seeds USD a
 * close dated then, and `holding_valued_at` carries closes *forward* only, so
 * a set dated earlier produces a chart point where even cash is unpriced.
 * Exported so a date control can carry the boundary: stated once, read twice.
 */
export function earliestRecordableDate(): string {
  return "1970-01-01";
}

/**
 * The furthest-ahead date {@link recordedDate} accepts. Exported as the date
 * control's `max`: stated once, read twice, so the markup hint cannot quietly
 * disagree with the refusal behind it.
 */
export function latestRecordableDate(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A date something was true on, `YYYY-MM-DD`. Three refusals, each earned:
 *
 * **Not on the calendar** — `2026-02-30` would reach the family as a driver
 * error rather than a sentence.
 *
 * **In the future** — the one that matters: "latest" is `max(as_of_date)` per
 * account, so a year typed 2126 pins the account until 2126, and a mistyped
 * digit becomes a balance that cannot be corrected by recording the right one.
 *
 * **Before the app can price anything** — `1026-08-24`, one digit from
 * `2026-08-24`, once flattened the "All" chart permanently with no way to
 * reach the row. The floor also disposes of `0000-01-01`, which JavaScript
 * accepts and Postgres has no year for.
 *
 * Tomorrow is allowed, and only tomorrow: the browser's date control speaks
 * local while this speaks UTC, so a household far enough east is on
 * tomorrow's date honestly. One day covers every real timezone; two would
 * start covering typos.
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
 * A quantity held, as a **signed** decimal string at `numeric(20, 8)`'s scale
 * — the opposite decision to {@link moneyMagnitude}, and the difference is
 * why both exist: that serves a form whose direction follows from the
 * account's kind (§2); this serves a box that opens *containing the quantity
 * already on the row* — a loan reads `−8,000` in the table and in the box,
 * and stripping the sign to re-derive it would print a number the screen has
 * never shown. Round-tripping `formatQuantity`'s output is therefore a hard
 * requirement: U+2212 and the thousands separators must both come back in.
 *
 * **`−0` is not a thing**: a debt of nothing written as though it were
 * something, and it would print as `−0` in the table.
 *
 * @param label how the quantity is named in a refusal, e.g. "A quantity".
 * @param maxIntegerDigits before the point; 12 is `numeric(20, 8)`'s room.
 */
export const signedQuantity = (label: string, maxIntegerDigits = 12) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    // U+2212 in, ASCII out: the table prints a true minus and the driver
    // takes a hyphen — converted once, here.
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
 * Unsigned: a price is a positive market fact even for a position held
 * negative (§2). Four decimal places, not {@link moneyMagnitude}'s two:
 * `cost_basis_per_share` is `numeric(20, 4)` and a box prefilled from it must
 * accept what it just printed. Blank becomes `null`, never `0`: a zero basis
 * claims the shares were free and prints a gain equal to the whole position.
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
 * A tax rate typed as a percentage — `23.8`, not `0.238`: what a person says,
 * what the form asks, what the panel prints, what the column stores; the one
 * conversion to a multiplier lives where the multiplying happens.
 * `bareDecimal` again, so `23.8%` pasted from a tax table equals `23.8` typed
 * — the sign is the one generosity withheld, a negative rate not being a
 * rate. **No `Number`** (§4.1).
 *
 * @param label how the rate is named in a refusal, e.g. "A tax rate".
 * @param decimals after the point; defaults to the share scale the column stores.
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
