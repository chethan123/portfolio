import { useEffect, useState, type ComponentProps } from "react";

import { Amount } from "~/components/amount";
import {
  DECIMAL_FORMAT_HINT,
  parseDecimalInput,
  type DecimalInputRule,
} from "~/lib/decimal-input";

type Props = Omit<ComponentProps<"input">, "onChange"> & {
  compact?: boolean;
  noteId: string;
  onServerErrorActiveChange?: (active: boolean) => void;
  rule: DecimalInputRule;
  serverErrorId?: string;
  shape: "money" | "quantity" | "percentage";
};

const PUNCTUATION_ECHO = "Punctuation reads as";

function clientRefusalIsLive({
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
  noteId,
  onServerErrorActiveChange,
  rule,
  serverErrorId,
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
  const serverErrorActive = serverErrorId !== undefined && typed === initial;
  const announceInvalid = clientRefusalIsLive({
    hydrated,
    invalid,
    hasServerError: serverErrorId !== undefined,
    matchesServerValue: serverErrorActive,
  });
  const describedBy = [serverErrorActive ? serverErrorId : undefined, input["aria-describedby"]]
    .filter((id) => id !== undefined && id !== "")
    .join(" ");

  // Server render carries only fixed grammar; hydration adds punctuation normalization or a refusal.
  useEffect(() => setHydrated(true), []);
  useEffect(
    () => onServerErrorActiveChange?.(serverErrorActive),
    [onServerErrorActiveChange, serverErrorActive],
  );

  return (
    <span
      className={`interpreted-number-input${compact ? " interpreted-number-input--compact" : ""}`}
    >
      <input
        {...input}
        aria-describedby={describedBy || undefined}
        aria-invalid={serverErrorActive || invalid ? true : undefined}
        defaultValue={defaultValue}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setTyped(value);
          onServerErrorActiveChange?.(serverErrorId !== undefined && value === initial);
        }}
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
