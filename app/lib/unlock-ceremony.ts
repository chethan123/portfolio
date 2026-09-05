/**
 * The client-only seam onto `@simplewebauthn/browser` (docs/adr/0012, spec
 * 0019, tickets 04 and 05) — the one file in this application that names
 * that package, and it never does so at module scope. Every export below
 * reaches it through a dynamic `import()` inside a function body, so the
 * package is only ever resolved and evaluated when a browser actually calls
 * one of these functions — which happens from `unlock.tsx`'s component and
 * from Settings → Passkeys' (`app/routes/settings/passkeys.tsx`) only inside
 * a `useEffect` or an event handler, neither of which ever runs during a
 * server render. A static `import { startAuthentication } from
 * "@simplewebauthn/browser"` at the top of this file (or of either route)
 * would sit in the module's top-level scope in *every* bundle that pulls
 * this module in, including the server one, which is exactly the shape
 * CLAUDE.md's bundle-boundary rule forbids for a route that renders on the
 * server — `npm run build`, checked against `build/client/assets/**` and
 * `build/server/index.js` directly, is what proves this holds and not an
 * argument about which file the import sits in.
 *
 * Plain `.ts`, not `.server.ts`: this ships to the browser on purpose, the
 * mirror image of that suffix's usual meaning.
 *
 * **Only types cross statically.** `PublicKeyCredentialRequestOptionsJSON`,
 * `PublicKeyCredentialCreationOptionsJSON`, `AuthenticationResponseJSON` and
 * `RegistrationResponseJSON` are `import type`s, erased entirely by
 * `verbatimModuleSyntax` — they add nothing to any bundle, so importing them
 * from this package rather than restating them by hand is free.
 *
 * **What a cancelled or timed-out prompt actually throws — for both
 * ceremonies.** Checked against the installed
 * `node_modules/@simplewebauthn/browser@14.0.0` source
 * (`esm/methods/startAuthentication.js` and `startRegistration.js`, each
 * calling its own `identifyAuthenticationError.js`/
 * `identifyRegistrationError.js`) rather than assumed: a
 * `navigator.credentials.get()` **or** `.create()` rejection named
 * `NotAllowedError` is passed straight through by both helpers, wrapped in a
 * `WebAuthnError` whose own `code` is the literal
 * `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY` and whose comment says why —
 * "Platforms are overloading this error beyond what the spec defines and we
 * don't want to overwrite potentially useful error messages." Critically,
 * `WebAuthnError`'s constructor sets `this.name = name ?? cause.name`, and
 * the `NotAllowedError` branch passes no `name` override, so the thrown
 * error's `.name` really is `"NotAllowedError"` — checking it is checking
 * the platform's own signal, not a guess. The same DOMException name is
 * spec-overloaded for a dismissed prompt *and* a ceremony that simply ran out
 * of time, and nothing observable here tells the two apart — which is why
 * neither {@link requestAssertion} nor {@link requestRegistration} tries to,
 * and why neither screen's copy for this outcome claims to know which one
 * happened.
 *
 * **A registration's own `InvalidStateError`** — the client-side half of
 * `lock.server.ts`'s `excludeCredentials`, an authenticator the server
 * already knows about refusing to create a second credential for this
 * relying party — has an outcome of its own rather than falling to the
 * generic `"failed"` branch. It has to: the generic branch prints the
 * library's own message, and "The authenticator was previously registered"
 * is a sentence about authenticators rather than about what this household
 * should do next. `identifyRegistrationError.js`'s `InvalidStateError`
 * branch sets `code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"` and passes
 * no `name` override, and `webAuthnError.js`'s constructor is
 * `this.name = name ?? cause.name` — so the thrown error's `.name` really is
 * the platform's own `"InvalidStateError"`, which is what this matches on.
 * The server's `DUPLICATE_PASSKEY_MESSAGE` is still the other half, for
 * whatever reaches it anyway.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * Whether this browser can even attempt the ceremony — many in-app WebView
 * browsers offer no *completable* ceremony, which is the practical failure
 * this exists to catch (see this file's header on what that global's mere
 * presence does and does not promise). Read once, after mount, to decide
 * what the screen shows; never to decide what the server allows (ADR-0012,
 * ticket 04: "no capability check anywhere decides whether a request is
 * refused").
 *
 * **Failing to even load the check is treated the same as failing it.** The
 * package is its own lazily-loaded chunk, fetched here for the first time on
 * this screen — on the one screen whose story is "the phone off the VPN" —
 * and a `catch` with no capability to report is exactly the honest answer:
 * a browser that cannot load the check cannot run it either, so it gets the
 * same recovery message a genuinely unsupported one would, rather than a
 * button that mounts successfully and then can never be pressed to any
 * effect (finding 6).
 */
export async function supportsPasskeys(): Promise<boolean> {
  try {
    const { browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/**
 * What one attempt at the ceremony produced. `"dismissed"` covers both a
 * prompt the person closed and one that timed out waiting — the platform
 * gives this module no way to tell those apart (this file's header), so the
 * type does not pretend to either. `"failed"` is everything else a browser
 * can throw before ever producing an assertion — rare, and carries the
 * library's own message rather than an invented one.
 */
export type AssertionOutcome =
  | { status: "ok"; response: AuthenticationResponseJSON }
  | { status: "dismissed" }
  | { status: "failed"; message: string };

/**
 * Run the assertion ceremony against server-issued options. Never verifies
 * anything and never talks to this instance's own server — that is
 * `verifyUnlock`'s job, behind `.server.ts`'s own boundary; this only asks
 * the browser to produce a signed response or say why it could not.
 */
export async function requestAssertion(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AssertionOutcome> {
  // The dynamic `import()` sits inside the same `try` as the ceremony call
  // it feeds, deliberately (finding 6): a failed chunk load is a browser
  // that could not run the check, same as one that ran it and refused, and
  // both belong on the "failed" branch below rather than as an unhandled
  // rejection that leaves the screen's button disabled forever with no
  // note. `error.name` is never `"NotAllowedError"` for an import failure —
  // that name is a DOMException the *ceremony* throws — so a load failure
  // always falls to the generic branch, carrying whatever message the
  // failed `fetch` behind the import left on `error.message`.
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

/** {@link AssertionOutcome}'s registration twin — ticket 05's second ceremony. */
export type RegistrationOutcome =
  | { status: "ok"; response: RegistrationResponseJSON }
  | { status: "dismissed" }
  // The provider already holds a passkey for this app and will not make a
  // second — a dead end for this attempt rather than a failure to retry, so
  // it carries no message and the screen supplies its own.
  | { status: "alreadyRegistered" }
  | { status: "failed"; message: string };

/**
 * Run the registration ceremony against server-issued options — the second
 * of enrolling another passkey's two taps (spec 0019), or the whole of
 * enrolling the first. Never verifies anything and never talks to this
 * instance's own server; that is `completeRegistration`'s job, behind
 * `.server.ts`'s own boundary. This only asks the browser to create a
 * credential and produce a signed response, or say why it could not.
 */
export async function requestRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationOutcome> {
  // Same shape as {@link requestAssertion}'s own try, for the same reason: a
  // failed chunk load reads as "could not run this ceremony", not a crash.
  try {
    const { startRegistration } = await import("@simplewebauthn/browser");
    const response = await startRegistration({ optionsJSON });
    return { status: "ok", response };
  } catch (error) {
    if (error instanceof Error && error.name === "NotAllowedError") {
      return { status: "dismissed" };
    }
    // Its own outcome rather than the generic branch — see this file's header
    // for why `.name` here is the platform's own signal and not the library's
    // invention.
    if (error instanceof Error && error.name === "InvalidStateError") {
      return { status: "alreadyRegistered" };
    }
    return {
      status: "failed",
      // Its own wording, not {@link requestAssertion}'s — creating a
      // credential is not "a check", and a load failure reported in the
      // assertion's own words would misname the ceremony that actually failed.
      message: error instanceof Error ? error.message : "The passkey creation could not run.",
    };
  }
}
