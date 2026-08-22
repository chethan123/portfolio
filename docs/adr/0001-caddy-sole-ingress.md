# All ingress through Caddy; the app and database publish no ports

The app trusts `X-Forwarded-*` headers, and that trust is only sound while the proxy is the only
thing that can connect to it. Previously `compose.yaml` published the app on all interfaces and
`docs/operating.md` asked operators to bind it back to loopback themselves in a
`compose.override.yaml`. A `caddy` service now ships in `compose.yaml` and is the only container
that publishes a port, so the property holds by construction rather than by the operator
remembering to do something.

## Consequences

TLS is deliberately not configured yet. Caddy proxies plain HTTP on port 80, so what this buys is
topology, not confidentiality, and the instance is still not safe to expose to the internet —
terminating TLS is Caddy's job once it is set up, either by naming a real host in the `Caddyfile`
or by fronting Caddy with an existing TLS-terminating proxy. Until one of those is done the PWA
constraint in DESIGN.md §10 still applies.

Caddy is now a single point of failure for all traffic, which is the price of the guarantee. The
CI smoke test asserts the port topology directly — `app` and `db` unpublished, `caddy` on 80 — so
a regression fails the build rather than silently re-exposing the app.
