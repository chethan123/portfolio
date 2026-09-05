import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../server/config.ts";

const MINIMAL = {
  DATABASE_URL: "postgres://portfolio:portfolio@db:5432/portfolio",
  PUBLIC_ORIGIN: "https://portfolio.example.com",
};

/** Every assertion here is about what an operator sees when they get it wrong. */
describe("configuration validation", () => {
  it("names the missing variable when a required setting is absent", () => {
    try {
      loadConfig({});
      expect.unreachable("expected loadConfig to reject an empty environment");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("DATABASE_URL");
    }
  });

  it("names the offending variable when a value is the wrong shape", () => {
    try {
      loadConfig({ DATABASE_URL: "mysql://nope/portfolio" });
      expect.unreachable("expected loadConfig to reject a non-Postgres URL");
    } catch (error) {
      expect((error as ConfigError).message).toContain("DATABASE_URL");
    }
  });

  it("names PUBLIC_ORIGIN when it is absent, same as DATABASE_URL", () => {
    try {
      loadConfig({ DATABASE_URL: MINIMAL.DATABASE_URL });
      expect.unreachable("expected loadConfig to reject a missing PUBLIC_ORIGIN");
    } catch (error) {
      expect((error as ConfigError).message).toContain("PUBLIC_ORIGIN");
    }
  });

  it("refuses a spelling of PUBLIC_ORIGIN that looks right but is not already canonical", () => {
    // The canonical spelling is the baseline the four below are held against.
    expect(
      loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "https://portfolio.example.com" }).PUBLIC_ORIGIN,
    ).toBe("https://portfolio.example.com");

    // Each of these parses cleanly as a URL — the only thing that has ever
    // validated this value before — but none is the exact string the browser
    // sends, or the string the gate concatenates its callback from, so each
    // has to be refused by name rather than silently canonicalised.
    const nonCanonical = [
      "https://portfolio.example.com/", // trailing slash
      "HTTPS://Portfolio.Example.COM", // upper case
      "https://portfolio.example.com:443", // the default port written out
      "https://portfolio.example.com\n", // a stray newline from a .env file
    ];

    for (const value of nonCanonical) {
      try {
        loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: value });
        expect.unreachable(`expected loadConfig to refuse ${JSON.stringify(value)}`);
      } catch (error) {
        const { message } = error as ConfigError;
        expect(message).toContain("PUBLIC_ORIGIN");
        expect(message).toMatch(/canonical/);
      }
    }
  });

  it("refuses a plain http origin that is not localhost", () => {
    // The Secure Contexts carve-out is `localhost`-shaped, not scheme-shaped:
    // nothing else gets to skip TLS.
    expect(() =>
      loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "http://portfolio.example.com" }),
    ).toThrow(/PUBLIC_ORIGIN/);
  });

  it("accepts http://localhost, with or without a port, for the dev loop", () => {
    expect(loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "http://localhost" }).PUBLIC_ORIGIN).toBe(
      "http://localhost",
    );
    expect(loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "http://localhost:5173" }).PUBLIC_ORIGIN).toBe(
      "http://localhost:5173",
    );
  });

  it("refuses an IP-address host, which the specification forbids as a relying-party id", () => {
    expect(() => loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "https://127.0.0.1" })).toThrow(
      /PUBLIC_ORIGIN/,
    );
    expect(() => loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "https://[::1]" })).toThrow(
      /PUBLIC_ORIGIN/,
    );
  });

  it("refuses a value carrying a path", () => {
    // compose.yaml builds the gate's own redirect as PUBLIC_ORIGIN +
    // "/oauth2/callback"; a value that already carries a path would make that
    // concatenation a URL Google never registered, and it is not a valid
    // WebAuthn expected origin either.
    expect(() =>
      loadConfig({ ...MINIMAL, PUBLIC_ORIGIN: "https://portfolio.example.com/oauth2/callback" }),
    ).toThrow(/PUBLIC_ORIGIN/);
  });

  it("names every offending variable at once rather than one per restart", () => {
    try {
      loadConfig({ ...MINIMAL, PORT: "http", MARKET_TIMEZONE: "Mars/Olympus_Mons" });
      expect.unreachable("expected loadConfig to reject both bad values");
    } catch (error) {
      const { message } = error as ConfigError;
      expect(message).toContain("PORT");
      expect(message).toContain("MARKET_TIMEZONE");
    }
  });

  it("applies the documented defaults so a minimal configuration is short", () => {
    const config = loadConfig(MINIMAL);

    expect(config.PORT).toBe(3000);
    expect(config.MAX_UPLOAD_MB).toBe(10);
    expect(config.MARKET_TIMEZONE).toBe("America/New_York");
    expect(config.TZ).toBe("UTC");

    // "Nothing is in front of me" is the honest default: it is what a checkout
    // is, and it is the answer that leaves the warning banner showing.
    expect(config.AUTH_GATE).toBe("none");
  });

  it("validates the market timezone and parses it rather than merely tolerating it", () => {
    expect(() => loadConfig({ ...MINIMAL, MARKET_TIMEZONE: "not/a/zone" })).toThrow(
      /MARKET_TIMEZONE/,
    );

    const config = loadConfig({ ...MINIMAL, MARKET_TIMEZONE: "Europe/London" });
    expect(config.MARKET_TIMEZONE).toBe("Europe/London");
  });

  it("parses the upload cap and refuses anything that is not a whole megabyte count", () => {
    expect(loadConfig({ ...MINIMAL, MAX_UPLOAD_MB: "25" }).MAX_UPLOAD_MB).toBe(25);

    // "2.5" and "ten" are both refused as non-integers; "0" trips the minimum,
    // because a cap of zero megabytes is an upload form that accepts nothing.
    expect(() => loadConfig({ ...MINIMAL, MAX_UPLOAD_MB: "2.5" })).toThrow(/MAX_UPLOAD_MB/);
    expect(() => loadConfig({ ...MINIMAL, MAX_UPLOAD_MB: "ten" })).toThrow(/MAX_UPLOAD_MB/);
    expect(() => loadConfig({ ...MINIMAL, MAX_UPLOAD_MB: "0" })).toThrow(/MAX_UPLOAD_MB/);
  });

  it("takes the two gate postures and refuses anything else by name", () => {
    expect(loadConfig({ ...MINIMAL, AUTH_GATE: "external" }).AUTH_GATE).toBe("external");
    expect(loadConfig({ ...MINIMAL, AUTH_GATE: "none" }).AUTH_GATE).toBe("none");

    // A typo, and a plausible guess at a boolean. Both have to fail loudly:
    // silently reading either as "a gate fronts me" would hide the warning on
    // an instance with nothing in front of it, which is the one wrong answer
    // this setting can give.
    expect(() => loadConfig({ ...MINIMAL, AUTH_GATE: "externl" })).toThrow(/AUTH_GATE/);
    expect(() => loadConfig({ ...MINIMAL, AUTH_GATE: "true" })).toThrow(/AUTH_GATE/);
  });

  it("treats an empty value as unset rather than as a configured empty string", () => {
    // An unsubstituted Compose variable or a bare `PORT=` in a .env file.
    expect(loadConfig({ ...MINIMAL, PORT: "" }).PORT).toBe(3000);
    expect(loadConfig({ ...MINIMAL, AUTH_GATE: "" }).AUTH_GATE).toBe("none");
  });
});
