// The form grammar for a typed decimal. It stays browser-safe so the preview and every server-side
// financial field interpret and validate the same exact string without floating-point arithmetic.

export type DecimalInputReason =
  | "grouping"
  | "syntax"
  | "incomplete"
  | "sign"
  | "scale"
  | "size"
  | "range";

export type DecimalInput =
  | { kind: "decimal"; value: string }
  | { kind: "invalid"; reason: DecimalInputReason };

export type DecimalInputOptions = Readonly<{
  allowTrailingPercent?: boolean;
  sign?: "allowed" | "refused";
  maxDecimals?: number;
  maxIntegerDigits?: number;
  max?: string;
}>;

export type DecimalInputRule = Readonly<{
  label: string;
  options: DecimalInputOptions;
  message: (reason: DecimalInputReason) => string;
}>;

export const DECIMAL_FORMAT_HINT =
  "Use a point for decimals. Commas or spaces group thousands in threes: 1,234.56 is read as 1234.56. A leading + and a trailing point are allowed: +5 and 5. both read as 5.";

// ECMAScript whitespace except line terminators. These are grouping or surrounding spaces, while a
// newline is never part of one financial field.
const SPACE = "\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff";
const LINE_TERMINATOR = /[\r\n\u2028\u2029]/;
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");
const LEADING_SPACE = new RegExp(`^[${SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`);
const GROUP_SEPARATOR = new RegExp(`[,${SPACE}]`);
const GROUPED_INTEGER = new RegExp(`^\\d{1,3}([,${SPACE}])\\d{3}(?:\\1\\d{3})*$`);
const NUMBER_CHARACTERS = new RegExp(`^[\\d.,${SPACE}]+$`);
const REMOVE_GROUP_SEPARATOR = new RegExp(`[,${SPACE}]`, "g");

function integerDigits(value: string): number {
  return (value.split(".")[0] ?? "").replace(/^-/, "").replace(/^0+/, "").length;
}

function decimalPlaces(value: string): number {
  return (value.split(".")[1] ?? "").length;
}

// Both values have already passed the decimal grammar. Comparing padded digit strings avoids a
// Number conversion and therefore preserves every digit at the financial boundary.
function decimalIsGreaterThan(value: string, maximum: string): boolean {
  const [valueInteger = "0", valueFraction = ""] = value.replace(/^\+/, "").split(".");
  const [maxInteger = "0", maxFraction = ""] = maximum.replace(/^\+/, "").split(".");
  const leftInteger = valueInteger.replace(/^0+/, "") || "0";
  const rightInteger = maxInteger.replace(/^0+/, "") || "0";

  if (leftInteger.length !== rightInteger.length) return leftInteger.length > rightInteger.length;
  if (leftInteger !== rightInteger) return leftInteger > rightInteger;

  const scale = Math.max(valueFraction.length, maxFraction.length);
  return valueFraction.padEnd(scale, "0") > maxFraction.padEnd(scale, "0");
}

export function parseDecimalInput(
  input: string,
  {
    allowTrailingPercent = false,
    sign = "allowed",
    maxDecimals,
    maxIntegerDigits,
    max,
  }: DecimalInputOptions = {},
): DecimalInput {
  if (LINE_TERMINATOR.test(input)) return { kind: "invalid", reason: "syntax" };

  let value = input.replace(EDGE_SPACE, "");
  if (value === "") return { kind: "decimal", value: "" };

  if (allowTrailingPercent && value.endsWith("%")) {
    value = value.slice(0, -1).replace(TRAILING_SPACE, "");
  }
  if (value.includes("%")) return { kind: "invalid", reason: "syntax" };

  let negative = false;
  const takeSign = (allowPlus = true) => {
    if ((allowPlus && value.startsWith("+")) || /^[\-−]/.test(value)) {
      negative = /^[\-−]/.test(value);
      value = value.slice(1).replace(LEADING_SPACE, "");
      return true;
    }
    return false;
  };

  const signBeforeDollar = takeSign();
  if (value.startsWith("$")) {
    value = value.slice(1).replace(LEADING_SPACE, "");
    if (!signBeforeDollar) takeSign(false);
  }

  if (negative && sign === "refused") return { kind: "invalid", reason: "sign" };
  if (/[$+\-−]/.test(value)) return { kind: "invalid", reason: "syntax" };
  if (value === "") {
    return { kind: "invalid", reason: negative ? "incomplete" : "syntax" };
  }

  if (!NUMBER_CHARACTERS.test(value)) return { kind: "invalid", reason: "syntax" };

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
    integer = integer.replace(REMOVE_GROUP_SEPARATOR, "");
  } else if (integer !== "" && !/^\d+$/.test(integer)) {
    return { kind: "invalid", reason: "syntax" };
  }

  if (integer === "" && (fraction === null || fraction === "")) {
    return { kind: "invalid", reason: "syntax" };
  }

  const whole = integer === "" ? "0" : integer;
  const unsigned = fraction === null || fraction === "" ? whole : `${whole}.${fraction}`;
  const decimal = `${negative ? "-" : ""}${unsigned}`;

  if (maxDecimals !== undefined && decimalPlaces(decimal) > maxDecimals) {
    return { kind: "invalid", reason: "scale" };
  }
  if (maxIntegerDigits !== undefined && integerDigits(decimal) > maxIntegerDigits) {
    return { kind: "invalid", reason: "size" };
  }
  if (max !== undefined && !negative && decimalIsGreaterThan(decimal, max)) {
    return { kind: "invalid", reason: "range" };
  }

  return { kind: "decimal", value: decimal };
}

export function decimalFormatMessage(label: string): string {
  return `${label} has ambiguous or invalid grouping. Commas or spaces group thousands in threes, so 1,5 is refused.`;
}

export function moneyMagnitudeRule(label: string, maxIntegerDigits = 12): DecimalInputRule {
  return {
    label,
    options: { sign: "refused", maxDecimals: 2, maxIntegerDigits },
    message: (reason) => {
      if (reason === "grouping") return decimalFormatMessage(label);
      if (reason === "sign") {
        return (
          `${label} is entered as a plain amount, without a minus sign — ` +
          "whether it counts for or against you follows from the kind of account it is."
        );
      }
      if (reason === "scale") {
        return `${label} is recorded to the cent, so it takes at most two decimal places.`;
      }
      if (reason === "size") return `${label} is larger than this application can store.`;
      return `${label} must be an amount in dollars, like 1,250.00.`;
    },
  };
}

export function signedQuantityRule(label: string, maxIntegerDigits = 12): DecimalInputRule {
  return {
    label,
    options: { sign: "allowed", maxDecimals: 8, maxIntegerDigits },
    message: (reason) => {
      if (reason === "grouping") return decimalFormatMessage(label);
      if (reason === "scale") {
        return (
          `${label} is recorded to 8 decimal places, which is finer than any ` +
          "brokerage reports a fractional share."
        );
      }
      if (reason === "size") return `${label} is larger than this application can store.`;
      if (reason === "incomplete") return `${label} is required.`;
      return `${label} must be a number, like 120.5 — or −8,000 for something owed.`;
    },
  };
}

export function perShareAmountRule(label: string, maxIntegerDigits = 16): DecimalInputRule {
  return {
    label,
    options: { sign: "refused", maxDecimals: 4, maxIntegerDigits },
    message: (reason) => {
      if (reason === "grouping") return decimalFormatMessage(label);
      if (reason === "sign") {
        return (
          `${label} is what one share cost, which is never negative — a position held short or ` +
          "owed carries its sign in the quantity instead."
        );
      }
      if (reason === "scale") {
        return `${label} is recorded to 4 decimal places, and no further.`;
      }
      if (reason === "size") return `${label} is larger than this application can store.`;
      return `${label} must be an amount in dollars, like 92.4150.`;
    },
  };
}

export function percentRateRule(label: string, decimals = 6): DecimalInputRule {
  return {
    label,
    options: {
      allowTrailingPercent: true,
      sign: "refused",
      maxDecimals: decimals,
      max: "100",
    },
    message: (reason) => {
      if (reason === "grouping") return decimalFormatMessage(label);
      if (reason === "sign") return `${label} cannot be negative.`;
      if (reason === "scale") return `${label} takes at most ${decimals} decimal places.`;
      if (reason === "range") return `${label} cannot be more than 100%.`;
      return `${label} must be a percentage, like 23.8.`;
    },
  };
}
