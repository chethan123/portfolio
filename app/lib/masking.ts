/**
 * The masking vocabulary, once (spec 0007, ADR-0002).
 *
 * A screen is **masked** when every amount on it is replaced by a fixed run of
 * dots. The **masking policy** is the household's standing choice of what a
 * browser nobody has toggled yet opens in. `CONTEXT.md` defines both, and the
 * words here are that glossary's.
 *
 * Not a `.server` module, and for `account-options.ts`'s reason: the domain
 * module validates against these values and the Display form renders options
 * from them, and a list written twice is a list free to drift from the schema's
 * check constraint. Everything here is plain data and pure functions over it.
 */
import type { Option } from "./account-options.ts";

/**
 * What a browser that has not been toggled yet opens in.
 *
 * The values match `app_setting_masking_policy_valid` in `0007` exactly.
 * Adding one is a migration plus a line here, in that order.
 */
export type MaskingPolicy = "masked" | "unmasked" | "as_last_left";

/**
 * Three-way, never a boolean, for the reason the migration gives: the third
 * value is the one a household with settled habits actually wants, and a
 * boolean has no way to say it.
 *
 * The labels say what each answer *does to a browser*, because "masked" alone
 * reads as a description of the current screen rather than as a rule about
 * every future one.
 */
export const MASKING_POLICIES: ReadonlyArray<Option<MaskingPolicy>> = [
  { value: "masked", label: "Start masked — every browser opens with amounts hidden" },
  { value: "unmasked", label: "Start unmasked — every browser opens showing amounts" },
  { value: "as_last_left", label: "As last left — each browser keeps what it was set to" },
];

/** The stored values alone, in the shape Zod's `enum` wants. */
export const maskingPolicyValues = MASKING_POLICIES.map((policy) => policy.value) as [
  MaskingPolicy,
  ...MaskingPolicy[],
];
