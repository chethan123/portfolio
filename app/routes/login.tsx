import { Form, redirect } from "react-router";

import { authGate, safeRedirectTarget } from "~/lib/auth.server";

import type { Route } from "./+types/login";

/**
 * The one login page — DESIGN.md §10.
 *
 * It exists only while `AUTH_PASSWORD` is set; with the gate off it redirects
 * away, because an open instance has nothing to log in to. There is no
 * registration, no password reset and no username: the password is an
 * environment variable and changing it is an operator action.
 */
export function meta() {
  return [{ title: "Sign in · Portfolio" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const gate = authGate();
  if (!gate.enabled) throw redirect("/");

  const next = safeRedirectTarget(new URL(request.url).searchParams.get("next"));
  if (await gate.isAuthenticated(request)) throw redirect(next);

  return { next };
}

export async function action({ request }: Route.ActionArgs) {
  const gate = authGate();
  if (!gate.enabled) throw redirect("/");

  const form = await request.formData();
  const password = form.get("password");
  const next = form.get("next");

  const result = await gate.logIn(
    typeof password === "string" ? password : "",
    typeof next === "string" ? next : null,
  );

  // A successful login is a redirect carrying the cookie; a failed one re-renders
  // this page. Same wording for a wrong password and an empty one — the form
  // reports nothing the visitor did not already supply.
  if (result.ok) throw result.response;
  return { error: result.message };
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <section className="page login">
      <h1>Sign in</h1>
      <p className="page-lede">This instance is password protected.</p>

      <Form method="post" className="login-form">
        <input type="hidden" name="next" value={loaderData.next} />

        <label className="login-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
        />

        {actionData?.error ? (
          <p className="login-error" role="alert">
            {actionData.error}
          </p>
        ) : null}

        <button type="submit">Sign in</button>
      </Form>
    </section>
  );
}
