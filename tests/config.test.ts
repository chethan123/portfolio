import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../server/config.ts";

const MINIMAL = { DATABASE_URL: "postgres://portfolio:portfolio@db:5432/portfolio" };

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
