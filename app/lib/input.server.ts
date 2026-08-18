/**
 * Turning a submitted form into domain input, and a refusal into something a
 * person can read.
 *
 * The domain modules own their own rules — `people.server.ts` decides what a
 * name is — and this module is only the shared vocabulary they express those
 * rules in: one error type carrying per-field messages, one parse helper, and
 * the two text shapes every settings form is built from.
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
