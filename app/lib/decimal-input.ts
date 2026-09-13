// The form grammar for a typed decimal. It stays browser-safe so the preview and every server-side
// financial field interpret punctuation with the same exact-string rule.

export type DecimalInput =
  | { kind: "decimal"; value: string }
  | { kind: "invalid"; reason: "grouping" | "syntax" };

export type DecimalInputOptions = Readonly<{ allowTrailingPercent?: boolean }>;

export const DECIMAL_FORMAT_HINT =
  "Use a point for decimals. Commas or spaces group thousands in threes: 1,234.56 is read as 1234.56.";

const GROUP_SEPARATOR = /[, \u00a0\u2009]/;
const GROUPED_INTEGER = /^\d{1,3}([, \u00a0\u2009])\d{3}(?:\1\d{3})*$/;

export function parseDecimalInput(
  input: string,
  { allowTrailingPercent = false }: DecimalInputOptions = {},
): DecimalInput {
  let value = input.trim();
  if (value === "") return { kind: "decimal", value: "" };

  if (allowTrailingPercent && value.endsWith("%")) {
    value = value.slice(0, -1).trimEnd();
  }
  if (value.includes("%")) return { kind: "invalid", reason: "syntax" };

  let sign = "";
  const takeSign = (allowPlus = true) => {
    if ((allowPlus && value.startsWith("+")) || /^[\-−]/.test(value)) {
      sign = value.startsWith("+") ? "" : "-";
      value = value.slice(1).replace(/^[ \u00a0\u2009]+/, "");
      return true;
    }
    return false;
  };

  const signBeforeDollar = takeSign();
  if (value.startsWith("$")) {
    value = value.slice(1).replace(/^[ \u00a0\u2009]+/, "");
    if (!signBeforeDollar) takeSign(false);
  }

  if (/[$+\-−]/.test(value)) return { kind: "invalid", reason: "syntax" };
  if (value === "") return { kind: "invalid", reason: "syntax" };

  if (!/^[\d., \u00a0\u2009]+$/.test(value)) return { kind: "invalid", reason: "syntax" };

  const point = value.indexOf(".");
  if (point !== value.lastIndexOf(".")) return { kind: "invalid", reason: "syntax" };

  let integer = point === -1 ? value : value.slice(0, point);
  const fraction = point === -1 ? null : value.slice(point + 1);

  if (fraction !== null && GROUP_SEPARATOR.test(fraction)) {
    return { kind: "invalid", reason: "grouping" };
  }
  if (fraction !== null && fraction !== "" && !/^\d+$/.test(fraction)) {
    return { kind: "invalid", reason: "syntax" };
  }

  if (GROUP_SEPARATOR.test(integer)) {
    if (!GROUPED_INTEGER.test(integer)) return { kind: "invalid", reason: "grouping" };
    integer = integer.replace(/[, \u00a0\u2009]/g, "");
  } else if (integer !== "" && !/^\d+$/.test(integer)) {
    return { kind: "invalid", reason: "syntax" };
  }

  if (integer === "" && (fraction === null || fraction === "")) {
    return { kind: "invalid", reason: "syntax" };
  }

  const whole = integer === "" ? "0" : integer;
  const decimal = fraction === null || fraction === "" ? whole : `${whole}.${fraction}`;
  return { kind: "decimal", value: `${sign}${decimal}` };
}

export function decimalFormatMessage(label: string): string {
  return `${label} has an ambiguous or invalid number format. ${DECIMAL_FORMAT_HINT}`;
}
