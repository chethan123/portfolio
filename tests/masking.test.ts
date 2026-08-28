/**
 * The precedence rule between the household's policy and one browser's cookie
 * (spec 0007, ADR-0002).
 *
 * Pure — no Postgres and no render — because this is the domain rule itself,
 * and `AGENTS.md` asks for domain rules to be tested as themselves. Exhausting
 * the same cases through database-backed renders would be slow and would prove
 * less: a screen full of dots tells you the resolver said `true`, not that it
 * said it for the right reason.
 *
 * The table is the point. Every policy is asked every question, so a rule that
 * quietly held for two of the three values cannot pass here — and the
 * combination that carries the whole feature's safety, *as last left* with
 * nothing left, is one row of it rather than a case someone remembered to add.
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

/** What a browser can arrive with: an answer, nothing, or noise. */
const COOKIES = {
  masked: MASKED,
  unmasked: UNMASKED,
  absent: undefined,
  unrecognised: "perhaps",
} as const;

type CookieCase = keyof typeof COOKIES;

/**
 * Every policy against every cookie, written as the answer a person would get.
 *
 * Read down a column: a recognised cookie gives the same answer under all three
 * policies, which is what makes the toggle work at all. Read across a row: the
 * policy only ever decides the cases where the browser has said nothing.
 */
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
    // The row above says this too, but it is stated again on its own because it
    // is the one that fails safe: a new device, a cleared jar and a private
    // window all arrive here, and every one of them must open masked rather
    // than open on a stranger's balances. ADR-0002 records the argument.
    expect(resolveMasked("as_last_left", undefined)).toBe(true);
  });

  it("takes the policy's answer rather than guessing when the cookie is nonsense", () => {
    // A truncated or hand-edited cookie is not a vote. Reading it as anything
    // other than "this browser has not answered" would let a corrupted value
    // decide, and half the corrupted values decide "show the balances".
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
    // This is what makes "on start" mean "a browser session nobody has toggled
    // yet" with no timer anywhere. Under a fixed policy the cookie has to die
    // with the session, or tomorrow's first visit would still be answering
    // yesterday's toggle and the policy would never apply again.
    expect(maskingCookie(true, "as_last_left")).toMatch(/max-age=\d+/i);
    expect(maskingCookie(true, "masked")).not.toMatch(/max-age/i);
    expect(maskingCookie(true, "unmasked")).not.toMatch(/max-age/i);
  });

  it("is scoped to the whole app and not sent across sites", () => {
    // Path, because the toggle is in the chrome and every screen has to see it.
    // SameSite, because a display preference has no business travelling on a
    // cross-site request even though nothing it carries is a secret.
    expect(maskingCookie(true, "masked")).toContain("Path=/");
    expect(maskingCookie(true, "masked")).toMatch(/samesite=lax/i);
  });

  it("is not HttpOnly, because the script that owns the toggle has to write it", () => {
    // Deliberate and load-bearing rather than an omission: the flip has to cost
    // nothing on a dead network, which means the client writes this itself.
    // ADR-0002 argues why that is correct — the cookie is a display preference
    // and grants nothing; the session cookie is a separate thing and stays
    // HttpOnly.
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
    // `unmasked=1` contains `masked=1`. A substring match would read another
    // cookie's value as this one's, and the failure would be silent and
    // one-directional.
    expect(readMaskingCookie(requestWith(`unmasked=${UNMASKED}`))).toBeUndefined();
  });
});
