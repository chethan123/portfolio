/**
 * Precedence between the household's policy and one browser's cookie (spec 0007, ADR-0002).
 * The table below asks every policy every question, so a rule quietly holding for two of
 * three values can't pass.
 */
import { describe, expect, it } from "vitest";

import {
  MASKED,
  UNMASKED,
  clearedMaskingCookie,
  maskingCookie,
  readMaskingCookie,
  resolveMasked,
  type MaskingPolicy,
} from "~/lib/masking";

const COOKIES = {
  masked: MASKED,
  unmasked: UNMASKED,
  absent: undefined,
  unrecognised: "perhaps",
} as const;

type CookieCase = keyof typeof COOKIES;

// column: a recognised cookie answers the same under all three policies (what makes the toggle work)
// row: policy only decides when the browser has said nothing
const EXPECTED: Record<MaskingPolicy, Record<CookieCase, boolean>> = {
  masked: { masked: true, unmasked: false, absent: true, unrecognised: true },
  unmasked: { masked: true, unmasked: false, absent: false, unrecognised: false },
  as_last_left: { masked: true, unmasked: false, absent: true, unrecognised: true },
};

describe("resolving whether a screen is masked", () => {
  for (const [policy, answers] of Object.entries(EXPECTED) as [
    MaskingPolicy,
    Record<CookieCase, boolean>,
  ][]) {
    for (const [cookie, expected] of Object.entries(answers) as [CookieCase, boolean][]) {
      it(`is ${expected ? "masked" : "unmasked"} under ${policy} with a ${cookie} cookie`, () => {
        expect(resolveMasked(policy, COOKIES[cookie])).toBe(expected);
      });
    }
  }

  it("treats a browser that has never been toggled as masked, whatever it was told to remember", () => {
    // fail-safe case: new device, cleared jar, private window all land here. ADR-0002.
    expect(resolveMasked("as_last_left", undefined)).toBe(true);
  });

  it("takes the policy's answer rather than guessing when the cookie is nonsense", () => {
    // a corrupted value isn't a vote; reading it as anything but "no answer" could show balances
    expect(resolveMasked("masked", "")).toBe(true);
    expect(resolveMasked("unmasked", "yes")).toBe(false);
  });
});

describe("the cookie both writers write", () => {
  it("says which state it carries in a vocabulary of exactly two words", () => {
    expect(maskingCookie(true, "as_last_left")).toContain(`masked=${MASKED}`);
    expect(maskingCookie(false, "as_last_left")).toContain(`masked=${UNMASKED}`);
  });

  it("outlives the browser session under as-last-left, and not under either fixed policy", () => {
    // under a fixed policy the cookie must die with the session, else tomorrow answers yesterday's toggle
    expect(maskingCookie(true, "as_last_left")).toMatch(/max-age=\d+/i);
    expect(maskingCookie(true, "masked")).not.toMatch(/max-age/i);
    expect(maskingCookie(true, "unmasked")).not.toMatch(/max-age/i);
  });

  it("is scoped to the whole app and not sent across sites", () => {
    // Path: toggle is in the chrome, every screen must see it. SameSite: no reason to cross sites.
    expect(maskingCookie(true, "masked")).toContain("Path=/");
    expect(maskingCookie(true, "masked")).toMatch(/samesite=lax/i);
  });

  it("is not HttpOnly, because the script that owns the toggle has to write it", () => {
    // deliberate: client writes it so the flip costs nothing on a dead network. ADR-0002.
    expect(maskingCookie(true, "masked")).not.toMatch(/httponly/i);
  });

  it("expires immediately when cleared, so a policy change takes effect where it was made", () => {
    expect(clearedMaskingCookie()).toMatch(/max-age=0/i);
    expect(clearedMaskingCookie()).toContain("Path=/");
  });
});

describe("reading the cookie off a request", () => {
  const requestWith = (cookie: string): Request =>
    new Request("http://portfolio.local/", { headers: { Cookie: cookie } });

  it("finds its own value among the others a browser sends", () => {
    expect(readMaskingCookie(requestWith(`_oauth2_proxy=abc; masked=${MASKED}`))).toBe(MASKED);
  });

  it("is undefined when the browser sent no cookies at all", () => {
    expect(readMaskingCookie(new Request("http://portfolio.local/"))).toBeUndefined();
  });

  it("does not mistake a cookie whose name merely ends in its own", () => {
    // "unmasked=1" contains "masked=1" — a substring match would silently misread it
    expect(readMaskingCookie(requestWith(`unmasked=${UNMASKED}`))).toBeUndefined();
  });
});
