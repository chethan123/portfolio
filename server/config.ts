/**
 * Configuration API: every setting is an env var, read only here.
 * DESIGN.md §10.1 has the table; .env.example documents defaults.
 * No side effects — runs bundled (Vite) and under type stripping.
 */
import { z } from "zod";

const POSTGRES_SCHEMES = ["postgres:", "postgresql:"];

const isValidTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// RP id can't be an IP (WebAuthn §5.1.3). URL() resolves odd spellings first
// (e.g. 0x7f.1 -> 127.0.0.1; IPv6 brackets survive) — test parsed hostname.
const IPV4_HOSTNAME = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIpAddress = (hostname: string): boolean =>
  hostname.startsWith("[") || IPV4_HOSTNAME.test(hostname);

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

/** Socket the price worker listens on; app dials the same path (spec 0018 §3.2). */
export const DEFAULT_PRICE_WORKER_SOCKET = "/run/price-worker/worker.sock";

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
   * https:// origin the proxy serves this at. No default. Also the lock's RP id
   * (docs/adr/0012-…) and gate's redirect base, shared with the sidecar —
   * refused rather than canonicalised: simplewebauthn compares raw `!==`, and
   * compose.yaml concatenates this string itself. Refines: scheme/host, path, canonical form.
   */
  PUBLIC_ORIGIN: z
    .string()
    .min(1, { message: "is required" })
    .refine((value) => {
      try {
        const { protocol, hostname } = new URL(value);
        if (isIpAddress(hostname)) return false;
        if (protocol === "https:") return true;
        // Secure Contexts carve-out: localhost allowed over http: for the dev loop.
        return protocol === "http:" && hostname === "localhost";
      } catch {
        return false;
      }
    }, {
      message:
        "must be an https:// origin whose host is a domain name, never an IP address, for " +
        "example 'https://portfolio.example.com' ('http://localhost' is accepted for the dev loop)",
    })
    .refine((value) => {
      try {
        const { pathname, search, hash, username, password } = new URL(value);
        return pathname === "/" && !search && !hash && !username && !password;
      } catch {
        return false;
      }
    }, {
      message:
        "must be a bare origin — no path, query, fragment or credentials — for example " +
        "'https://portfolio.example.com', not '.../oauth2/callback'",
    })
    .refine((value) => {
      try {
        return new URL(value).origin === value;
      } catch {
        return false;
      }
    }, {
      message:
        "must already be its own canonical origin, spelled exactly as `new URL(value).origin` " +
        "would render it — lower-case, no trailing slash, no default port written out, no stray " +
        "whitespace. 'https://portfolio.example.com' is canonical; " +
        "'https://portfolio.example.com/', 'HTTPS://Portfolio.Example.COM' and " +
        "'https://portfolio.example.com:443' all look right and are all refused",
    }),

  /**
   * external (sidecar auths, ADR-0005) or none — toggles only the
   * unprotected-instance banner. Union not boolean: room for a third posture.
   */
  AUTH_GATE: z
    .enum(["external", "none"], { error: "must be either 'external' or 'none'" })
    .default("none"),

  PORT: integerFromString("a TCP port")
    .refine((value) => value >= 1 && value <= 65535, {
      message: "must be a TCP port between 1 and 65535",
    })
    .default(3000),

  // Refresh cadence deliberately absent: household setting, not deployment's
  // (app_setting.refresh_cadence_minutes; 0008_refresh_cadence.sql).

  MAX_UPLOAD_MB: integerFromString("megabytes")
    .refine((value) => value >= 1, {
      message: "must be at least 1 megabyte",
    })
    .default(10),

  /** Zone used to pick a quote's trading day; storage is UTC regardless. */
  MARKET_TIMEZONE: timeZone.default("America/New_York"),

  /** Container clock only — storage is UTC regardless. */
  TZ: timeZone.default("UTC"),

  PRICE_WORKER_SOCKET: z.string().min(1).default(DEFAULT_PRICE_WORKER_SOCKET),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Worker's own schema — no DATABASE_URL/PUBLIC_ORIGIN (worker never sees
 * them; ignored if present); no TZ (reads no clock, image TZ=UTC, Dockerfile:94-96).
 */
const workerConfigSchema = z.object({
  PRICE_WORKER_SOCKET: z.string().min(1).default(DEFAULT_PRICE_WORKER_SOCKET),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

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

/** Empty-as-unset: `FOO=` reads as unset, not "set to empty". Turns a failed safeParse into one ConfigError naming every bad variable at once. */
function parseEnv<Schema extends z.ZodObject>(
  schema: Schema,
  env: Record<string, string | undefined>,
): z.infer<Schema> {
  const present: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== "") present[key] = value;
  }

  const result = schema.safeParse(present);

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

  return result.data as z.infer<Schema>;
}

/** Pure — no process.env read, no exit. @throws {ConfigError} naming every offending variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  return parseEnv(configSchema, env);
}

/** Worker's config (spec 0018 §3.5) — same empty-as-unset + ConfigError as loadConfig. @throws {ConfigError} */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  return parseEnv(workerConfigSchema, env);
}

let cached: Config | undefined;

export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
