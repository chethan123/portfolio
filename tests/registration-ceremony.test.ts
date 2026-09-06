/**
 * requestRegistration's own error mapping, driven for real rather than through a mock of
 * itself. Its own file because @simplewebauthn/browser is reached through a dynamic import()
 * inside the function body, so mocking it here would otherwise replace it for every test in
 * settings-passkeys.test.ts. The thrown error is shaped the way the library shapes it, not the
 * platform: identifyRegistrationError.js's InvalidStateError branch wraps the DOMException in
 * a WebAuthnError but leaves `.name` as the platform's own "InvalidStateError", which the
 * mapping matches on.
 */
import { describe, expect, it, vi } from "vitest";

const startRegistration = vi.hoisted(() => vi.fn());

// deliberately partial: the package's other two exports are destructured inside try blocks, so
// a future test calling supportsPasskeys/requestAssertion would get a quiet false/failed rather
// than a loud failure — add them here first
vi.mock("@simplewebauthn/browser", () => ({ startRegistration }));

const { requestRegistration } = await import("~/lib/unlock-ceremony");

// a PublicKeyCredentialCreationOptionsJSON only in the shape this function forwards
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
    // no message — this outcome carries none, so the panel can't print the library's wording by accident
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
