/**
 * `requestRegistration`'s own error mapping (`~/lib/unlock-ceremony`), driven
 * for real rather than through a mock of itself.
 *
 * Its own file because of what it has to mock. `@simplewebauthn/browser` is
 * reached through a dynamic `import()` inside the function body — the whole
 * point of that module's shape — so the only way to make the browser half
 * throw is to mock the package, and doing that inside
 * `tests/routes/settings-passkeys.test.ts` would replace it for every test
 * there. Nothing else in the suite drives this function: that file and
 * `tests/routes/unlock.test.ts` both mock `requestAssertion` and
 * `supportsPasskeys` over `importOriginal` and leave `requestRegistration`
 * real but uncalled, and `tests/unlock-ceremony-boundary.test.ts` only greps
 * the built output for where the package is named.
 *
 * The thrown error is shaped the way the library shapes it, not the way the
 * platform does: `identifyRegistrationError.js`'s `InvalidStateError` branch
 * wraps the DOMException in a `WebAuthnError` with
 * `code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"`, and
 * `webAuthnError.js`'s constructor sets `this.name = name ?? cause.name` with
 * no override on that branch — so `.name` survives as the platform's own
 * `"InvalidStateError"`, which is what the mapping matches on.
 */
import { describe, expect, it, vi } from "vitest";

const startRegistration = vi.hoisted(() => vi.fn());

// Deliberately partial: this file drives one function, and the package's
// other two exports (`browserSupportsWebAuthn`, `startAuthentication`) are
// destructured inside `try` blocks, so a future test here calling
// `supportsPasskeys` or `requestAssertion` would get a quiet `false` or
// `{status: "failed"}` rather than a loud failure. Add them here before
// adding such a test.
vi.mock("@simplewebauthn/browser", () => ({ startRegistration }));

const { requestRegistration } = await import("~/lib/unlock-ceremony");

/** A `PublicKeyCredentialCreationOptionsJSON` only in the shape this function forwards. */
const OPTIONS = {
  challenge: "Y2hhbGxlbmdl",
  rp: { name: "Portfolio Tracker", id: "portfolio.local" },
  user: { id: "dXNlcg", name: "Alex's phone", displayName: "Alex's phone" },
  pubKeyCredParams: [],
} satisfies Parameters<typeof requestRegistration>[0];

function thrown(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("what a registration ceremony's failures map to", () => {
  it("tells the screen the provider already holds a passkey, rather than handing back the library's own sentence", async () => {
    startRegistration.mockRejectedValueOnce(
      thrown("InvalidStateError", "The authenticator was previously registered"),
    );

    const outcome = await requestRegistration(OPTIONS);

    expect(outcome.status).toBe("alreadyRegistered");
    // No message: this outcome carries none, so the panel cannot print the
    // library's wording by accident.
    expect(outcome).toEqual({ status: "alreadyRegistered" });
  });

  it("still reads a dismissed or timed-out prompt as dismissed", async () => {
    startRegistration.mockRejectedValueOnce(thrown("NotAllowedError", "The operation was aborted"));

    expect(await requestRegistration(OPTIONS)).toEqual({ status: "dismissed" });
  });

  it("leaves every other failure on the generic branch, carrying its own message", async () => {
    startRegistration.mockRejectedValueOnce(thrown("NotSupportedError", "No supported algorithm"));

    expect(await requestRegistration(OPTIONS)).toEqual({
      status: "failed",
      message: "No supported algorithm",
    });
  });
});
