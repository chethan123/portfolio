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

/**
 * A relying-party id may not be an IP address (WebAuthn Level 3 §5.1.3), only
 * a domain string. `URL` normalises odd spellings before this ever runs —
 * `https://0x7f.1` arrives with `hostname` already resolved to `127.0.0.1`,
 * and an IPv6 literal's brackets survive into `hostname` too — so testing the
 * parsed hostname catches both spellings that testing the raw string would miss.
 */
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

/**
 * The unix socket the price worker listens on and the app dials (spec 0018
 * §3.2). One default, shared by {@link configSchema} and
 * {@link workerConfigSchema}: both processes have to agree on where the
 * socket is without either hard-coding the other's copy.
 */
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
   * The `https://` origin the house-wide proxy serves this instance at. No
   * default: there is nothing sensible to guess. Until now a Compose-level
   * value only `gate` read, building its Google redirect from it; the lock
   * (docs/adr/0012-a-browser-past-the-gate-is-shown-nothing.md) derives its
   * relying-party id from the same value, which is the app's first variable
   * shared with the sidecar. Three refinements, because they fail for
   * different reasons: a wrong scheme or host is silent until somebody
   * cannot enrol a passkey, a wrong path is silent until the gate's own
   * redirect breaks, and a non-canonical spelling of an otherwise-correct
   * origin is silent until every unlock and every enrolment refuses in
   * production — `@simplewebauthn/server` compares origins with a raw
   * `!==` against this string, and the browser will always send the
   * canonical form. A transform here could fix the app and still leave the
   * gate broken: `compose.yaml` builds its callback by concatenating this
   * value with `/oauth2/callback` at the Compose level, where no fix in
   * this file could reach — a trailing slash would still produce a
   * doubled-up path Google never registered. One variable has to mean one
   * thing to both services, so a non-canonical spelling is refused rather
   * than canonicalised.
   */
  PUBLIC_ORIGIN: z
    .string()
    .min(1, { message: "is required" })
    .refine((value) => {
      try {
        const { protocol, hostname } = new URL(value);
        if (isIpAddress(hostname)) return false;
        if (protocol === "https:") return true;
        // Secure Contexts' carve-out, not WebAuthn's: `localhost` is a valid
        // domain string under either scheme, but only `http:` gets the pass,
        // for the dev loop.
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

  /**
   * Where the price worker listens, and where the app's own calls dial
   * (spec 0018 §3.2, §3.3). Read here too — not only by
   * {@link loadWorkerConfig} — so the app's side of the socket comes through
   * the same `getConfig()` every other setting does; `server/config.ts`
   * stays the only reader of `process.env` (ARCHITECTURE.md §4.2).
   */
  PRICE_WORKER_SOCKET: z.string().min(1).default(DEFAULT_PRICE_WORKER_SOCKET),
});

export type Config = z.infer<typeof configSchema>;

/**
 * The worker's own schema: one key, the same default as {@link configSchema}'s
 * `PRICE_WORKER_SOCKET`. No `DATABASE_URL`, no `PUBLIC_ORIGIN` — the worker
 * never sees either, and one present in its environment is ignored rather
 * than validated. No `TZ`: the worker reads no clock, `period1` is the
 * library's own to parse, and the runtime reads `TZ` itself (`UTC` in the
 * image, `Dockerfile:94-96`).
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

/**
 * The empty-as-unset treatment, shared by every schema this module loads:
 * `FOO=` in a .env file or an unsubstituted Compose variable should not read
 * as "configured to empty". Also the single place that turns a failed
 * `safeParse` into a {@link ConfigError} naming every offending variable at
 * once, so a misconfigured deploy does not fix one variable per restart.
 */
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

/**
 * Validate an environment. Pure: it neither reads `process.env` nor exits.
 *
 * @throws {ConfigError} naming every offending variable.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  return parseEnv(configSchema, env);
}

/**
 * The worker's whole configuration (spec 0018 §3.5): one key, the same
 * empty-as-unset treatment and the same {@link ConfigError} as
 * {@link loadConfig} — proof, as much as an assertion, that the worker
 * starts with an environment holding nothing but a socket path.
 *
 * @throws {ConfigError} naming the offending variable.
 */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  return parseEnv(workerConfigSchema, env);
}

let cached: Config | undefined;

/** The process-wide configuration, parsed once on first use. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
