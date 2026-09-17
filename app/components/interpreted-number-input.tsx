import { useEffect, useState, type ComponentProps } from "react";

import { Amount } from "~/components/amount";
import {
  DECIMAL_FORMAT_HINT,
  parseDecimalInput,
  type DecimalInputRule,
} from "~/lib/decimal-input";

type Props = Omit<ComponentProps<"input">, "onChange"> & {
  compact?: boolean;
  hasServerError?: boolean;
  noteId: string;
  rule: DecimalInputRule;
  shape: "money" | "quantity" | "percentage";
};

export const PUNCTUATION_ECHO = "Punctuation reads as";

export function clientRefusalIsLive({
  hydrated,
  invalid,
  hasServerError,
  matchesServerValue,
}: Readonly<{
  hydrated: boolean;
  invalid: boolean;
  hasServerError: boolean;
  matchesServerValue: boolean;
}>): boolean {
  return hydrated && invalid && !(hasServerError && matchesServerValue);
}

export function InterpretedNumberInput({
  compact = false,
  hasServerError = false,
  noteId,
  rule,
  shape,
  defaultValue,
  ...input
}: Props) {
  const initial = typeof defaultValue === "string" ? defaultValue : "";
  const [hydrated, setHydrated] = useState(false);
  const [typed, setTyped] = useState(initial);
  const parsed = parseDecimalInput(typed, rule.options);
  const interpreted =
    hydrated && parsed.kind === "decimal" && parsed.value !== ""
      ? parsed.value
      : null;
  const invalidReason = parsed.kind === "invalid" ? parsed.reason : null;
  const invalid = typed.trim() !== "" && invalidReason !== null;
  const announceInvalid = clientRefusalIsLive({
    hydrated,
    invalid,
    hasServerError,
    matchesServerValue: typed === initial,
  });

  // Server render carries only fixed grammar; hydration adds punctuation normalization or a refusal.
  useEffect(() => setHydrated(true), []);

  return (
    <span
      className={`interpreted-number-input${compact ? " interpreted-number-input--compact" : ""}`}
    >
      <input
        {...input}
        defaultValue={defaultValue}
        onChange={(event) => setTyped(event.currentTarget.value)}
      />
      <span id={noteId} className="field-note">
        {compact ? null : DECIMAL_FORMAT_HINT}
        <span aria-live="polite">
          {announceInvalid && invalidReason !== null ? (
            <>
              {compact ? null : " "}
              {rule.message(invalidReason)}
            </>
          ) : null}
        </span>
        {invalid || interpreted === null ? null : (
          <>
            {compact ? null : " "}
            {PUNCTUATION_ECHO}{" "}
            <b className="u-data">
              {shape === "money" ? "$" : null}
              {shape === "percentage" ? (
                interpreted
              ) : (
                <Amount value={interpreted} shape="quantity" preservePlaces />
              )}
              {shape === "percentage" ? "%" : null}
            </b>
            .
          </>
        )}
      </span>
    </span>
  );
}
