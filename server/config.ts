/**
 * The whole configuration API: every setting is an environment variable,
 * every variable is described here, and this is the only reader of
 * `process.env`. DESIGN.md §10.1 holds the authoritative table;
 * `.env.example` documents it for operators. Dependency-light and
 * side-effect free because it runs two ways: bundled by Vite, and directly
 * under type stripping from `server/validate-config.ts` at container start.
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

  /**
   * Whether something in front of this instance authenticates people:
   * `external` = the Compose stack's forward-auth sidecar does (ADR-0005),
   * `none` = nothing does. The app authenticates nobody either way — the value
   * only decides whether the unprotected-instance banner is drawn. Behind a
   * gate the banner is a lie, and a warning a family learns to scroll past is
   * worse than none. A *description of the deployment, not a switch*:
   * `external` protects nothing, it only stops the app crying wolf. A union,
   * not a boolean, so a third posture is a value rather than a redesign;
   * `none` default because a bare checkout is what a developer has.
   */
  AUTH_GATE: z
    .enum(["external", "none"], { error: "must be either 'external' or 'none'" })
    .default("none"),

  PORT: integerFromString("a TCP port")
    .refine((value) => value >= 1 && value <= 65535, {
      message: "must be a TCP port between 1 and 65535",
    })
    .default(3000),

  // Quote refresh cadence is deliberately absent: the household's dial, not
  // the deployment's — it lives in `app_setting.refresh_cadence_minutes`,
  // edited at Settings → Prices. `0008_refresh_cadence.sql` has the argument.

  /**
   * Upload cap in whole megabytes. A brokerage CSV is tens of kilobytes — this
   * bounds what an accident can put in memory, not real use.
   */
  MAX_UPLOAD_MB: integerFromString("megabytes")
    .refine((value) => value >= 1, {
      message: "must be at least 1 megabyte",
    })
    .default(10),

  /**
   * Market-hours math, and the zone a quote's timestamp is read in to pick its
   * trading day. Storage is UTC regardless.
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

  return result.data;
}

let cached: Config | undefined;

/** The process-wide configuration, parsed once on first use. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
