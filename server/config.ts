/**
 * The whole configuration API of the application.
 *
 * Every setting is an environment variable and every environment variable is
 * described here. DESIGN.md §10.1 holds the authoritative table; `.env.example`
 * is its documentation for operators. This module is the only place that reads
 * `process.env`.
 *
 * Deliberately dependency-light and side-effect free so that it can be executed
 * two ways: bundled into the server build by Vite, and run directly by Node's
 * type stripping from `server/validate-config.ts` at container start.
 */
import { z } from "zod";

/** Postgres accepts either scheme in a connection URI. */
const POSTGRES_SCHEMES = ["postgres:", "postgresql:"];

const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const timeZone = z.string().refine(isValidTimeZone, {
  message: "must be an IANA time zone name, for example 'America/New_York'",
});

const integerFromString = (label: string) =>
  z
    .string()
    .refine((value) => /^-?\d+$/.test(value.trim()), {
      message: `must be a whole number (${label})`,
    })
    .transform((value) => Number.parseInt(value.trim(), 10));

const configSchema = z.object({
  /** Postgres connection string. No default: there is nothing sensible to guess. */
  DATABASE_URL: z
    .string()
    .min(1, { message: "is required" })
    .refine((value) => {
      try {
        return POSTGRES_SCHEMES.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, {
      message:
        "must be a Postgres connection URL, for example 'postgres://user:pass@db:5432/portfolio'",
    }),

  /** Cookie signing key. Required only once the login gate is switched on. */
  SESSION_SECRET: z.string().min(1).optional(),

  /** Setting this enables the optional login gate (DESIGN.md §10). */
  AUTH_PASSWORD: z.string().min(1).optional(),

  PORT: integerFromString("a TCP port")
    .refine((value) => value >= 1 && value <= 65535, {
      message: "must be a TCP port between 1 and 65535",
    })
    .default(3000),

  // The quote refresh cadence is deliberately absent here: it is the
  // household's dial rather than the deployment's, so it lives in
  // `app_setting.refresh_cadence_minutes` and is edited at Settings → Prices —
  // `0008_refresh_cadence.sql` carries the argument, including why the old
  // `PRICE_POLL_INTERVAL_MINUTES` was removed outright rather than kept as a
  // fallback.

  /**
   * The most a statement upload may carry, in whole megabytes. A brokerage CSV
   * is tens of kilobytes, so the cap bounds what an accident can put in
   * memory, not real use.
   */
  MAX_UPLOAD_MB: integerFromString("megabytes")
    .refine((value) => value >= 1, {
      message: "must be at least 1 megabyte",
    })
    .default(10),

  /**
   * Market-hours calculation, and the zone a quote's timestamp is read in to
   * decide which trading day it belongs to. Storage is UTC regardless.
   */
  MARKET_TIMEZONE: timeZone.default("America/New_York"),

  /** Container clock. The database stores UTC whatever this says. */
  TZ: timeZone.default("UTC"),
});

export type Config = z.infer<typeof configSchema>;

/** Thrown by {@link loadConfig}; `message` already names every bad variable. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "Invalid configuration. The following environment variables are wrong or missing:",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "See .env.example for the full environment surface and its defaults.",
      ].join("\n"),
    );
    this.problems = problems;
  }
}

/**
 * Validate an environment. Pure: it neither reads `process.env` nor exits.
 *
 * @throws {ConfigError} naming every offending variable.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat an empty string the same as unset: `FOO=` in a .env file or an
  // unsubstituted Compose variable should not read as "configured to empty".
  const present: Record<string, string> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== "") present[key] = value;
  }

  const result = configSchema.safeParse(present);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const variable = String(issue.path[0] ?? "configuration");
      const detail =
        issue.code === "invalid_type" && present[variable] === undefined
          ? "is required but not set"
          : issue.message;
      return `${variable} ${detail}`;
    });
    throw new ConfigError(problems);
  }

  const config = result.data;

  // Cross-field rule: the login gate needs something to sign its cookie with.
  if (config.AUTH_PASSWORD !== undefined && config.SESSION_SECRET === undefined) {
    throw new ConfigError([
      "SESSION_SECRET is required but not set (it becomes required as soon as AUTH_PASSWORD is set)",
    ]);
  }

  return config;
}

let cached: Config | undefined;

/** The process-wide configuration, parsed once on first use. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
