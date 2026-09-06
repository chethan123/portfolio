/**
 * The only file naming `@simplewebauthn/browser`, and only through dynamic `import()` inside
 * function bodies — a static import would put the package in the server bundle too.
 * docs/adr/0012, spec 0019
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * Decides what the screen shows, never what the server allows (ADR-0012).
 * A failed chunk load reads as unsupported — a browser that cannot load the check cannot run it.
 */
export async function supportsPasskeys(): Promise<boolean> {
  try {
    const { browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** `dismissed` is a closed prompt or a timeout — `NotAllowedError` is overloaded for both. */
export type AssertionOutcome =
  | { status: "ok"; response: AuthenticationResponseJSON }
  | { status: "dismissed" }
  | { status: "failed"; message: string };

export async function requestAssertion(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AssertionOutcome> {
  // Import inside the try: a failed chunk load lands on "failed", not an unhandled rejection.
  try {
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const response = await startAuthentication({ optionsJSON });
    return { status: "ok", response };
  } catch (error) {
    if (error instanceof Error && error.name === "NotAllowedError") {
      return { status: "dismissed" };
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "The passkey check could not run.",
    };
  }
}

export type RegistrationOutcome =
  | { status: "ok"; response: RegistrationResponseJSON }
  | { status: "dismissed" }
  // Provider already holds a passkey for this app: a dead end, not a retry — screen supplies the wording.
  | { status: "alreadyRegistered" }
  | { status: "failed"; message: string };

export async function requestRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationOutcome> {
  try {
    const { startRegistration } = await import("@simplewebauthn/browser");
    const response = await startRegistration({ optionsJSON });
    return { status: "ok", response };
  } catch (error) {
    if (error instanceof Error && error.name === "NotAllowedError") {
      return { status: "dismissed" };
    }
    // Authenticator already enrolled for this relying party (`excludeCredentials`).
    if (error instanceof Error && error.name === "InvalidStateError") {
      return { status: "alreadyRegistered" };
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "The passkey creation could not run.",
    };
  }
}
