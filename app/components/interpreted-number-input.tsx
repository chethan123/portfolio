import { useEffect, useState, type ComponentProps } from "react";

import { Amount } from "~/components/amount";
import { DECIMAL_FORMAT_HINT, parseDecimalInput } from "~/lib/decimal-input";

type Props = Omit<ComponentProps<"input">, "onChange"> & {
  compact?: boolean;
  noteId: string;
  shape: "money" | "quantity" | "percentage";
};

export function InterpretedNumberInput({
  compact = false,
  noteId,
  shape,
  defaultValue,
  ...input
}: Props) {
  const initial = typeof defaultValue === "string" ? defaultValue : "";
  const [hydrated, setHydrated] = useState(false);
  const [typed, setTyped] = useState(initial);
  const parsed = parseDecimalInput(typed, { allowTrailingPercent: shape === "percentage" });
  const interpreted =
    hydrated && parsed.kind === "decimal" && /^-?\d+(\.\d+)?$/.test(parsed.value)
      ? parsed.value
      : null;
  const invalid = hydrated && typed.trim() !== "" && parsed.kind === "invalid";

  // The server render carries only the fixed grammar; after hydration the exact echo follows the box.
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
      <span id={noteId} className="field-note" aria-live="polite">
        {compact ? null : DECIMAL_FORMAT_HINT}
        {invalid ? (
          <>{compact ? null : " "}This number format is ambiguous or invalid.</>
        ) : interpreted === null ? null : (
          <>
            {compact ? null : " "}Number format reads as{" "}
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
