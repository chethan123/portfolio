# Container hygiene audit

*Audited 2026-09-04 against `5e21ab7`: the runtime image built from the repository's own
`Dockerfile`, extracted and grepped whole, booted read-only against Postgres, and probed over HTTP.
Five independent reviews (an offensive security lens, a privacy lens, container packaging, supply
chain, and the running process), consolidated and then adversarially re-grounded before anything was
changed. What changed landed as the four commits following that revision; this document is the
record of what was looked for, what was found, and what was deliberately left alone.*

The question asked was the operator's: does the published image carry anything sensitive, or
anything that simply need not be there? The short answer is that it carries no secret, no household
data and no operator identity, and that what it did carry that it should not — a filesystem the
serving process could rewrite, four package managers, dead code from a dependency's CLI, a build's
scratch files, and two live advisories — is now gone.

## The three things worth knowing without reading further

1. **Nothing sensitive was in the image, and that answer was earned.** Every layer tar and the
   flattened rootfs were searched for key material, tokens, connection strings, dotfiles, the
   maintainer's handle and email, session identifiers, builder paths and sourcemaps. Zero hits
   that were not npm's own documentation. The image config carries no labels and no environment
   beyond what the Dockerfile sets. The fixtures and screenshots the repository ships are synthetic
   (an invented household, invented institutions), and none of them reach the image anyway.

2. **The serving uid owned its own code, and the migration runner would have run a planted file.**
   Every file under `/app` was `--chown`ed to the runtime user; nothing at runtime writes there.
   Proved as that user: a new `migrations/9999_*.sql` could be created, and the runner records
   filenames rather than contents, so it would execute on the next start as the database role.
   `compose.yaml`'s `read_only` closed this for the documented deployment; the plain `docker run`
   the Dockerfile explicitly supports had nothing. Fixed by ownership, asserted by the smoke test.

3. **The image's exposure was elsewhere than expected.** Not in secrets but in reach: `npm`/`npx`
   beside the price provider's egress (a one-command loader for published code), a default in the
   price client that fetches the npm registry on a schema failure, pages served with no cache
   directive while a masked page still carries every figure in its payload, and two `qs`
   advisories on the ungated `/healthz` path that the CI gate was set one level too high to catch.

## Method and its limits

The image was built here from the unmodified Dockerfile, with three sandbox accommodations that
cannot affect the runtime stage: base images pulled from a mirror of the same digests, the `deps`
stage taught to trust the sandbox's egress proxy certificate (three lines that exist in no shipped
layer — verified), and `--network=host`. The runtime stage is the repository's lines.

Each reviewer had the extracted rootfs, the per-layer tars, the image config and history, the live
container, and the repository. Findings needed a path or a command as evidence; hunches were kept
separate. A plan was then written from the findings and handed to a reviewer whose mandate was to
ground every claim against the repository and the libraries' actual code rather than the plan's
argument, and to hunt for near-copies of existing checks and for shapes more elaborate than the
problem. Two rounds; the second returned nothing material.

**Not checked here.** The multi-architecture image CI publishes to GHCR was not pulled and diffed
against this local build (same Dockerfile, but the `linux/arm64` leg is unexamined). No image
scanner ran (the sandbox could not reach Alpine's mirrors); the OS-layer comparison was made against
the `3.24-stable` branch of Alpine's package tree. `npm audit signatures` could not run through the
sandbox proxy; CI's run is the confirmation. No live Yahoo handshake was observed; the egress
description comes from reading the client library.

## 1. What the image is, and what it was carrying

**Sound, and unchanged.** Three stages; the selective `COPY` list holds — no source tree, no
tests, no dev dependencies, no compiler, no `.git`, no build-time environment. The production
package set is exactly the lockfile's non-dev set minus the prune script's cut and `typescript`,
reconciled entry by entry. The server bundle's external imports all resolve inside the image, and
the only unresolved dependency edges are precisely the cut ones. No native binary anywhere in
`node_modules`, which is independent confirmation of the Dockerfile's pure-JavaScript invariant.
The `docker diff` of a healthy, request-serving container is empty; so is that of a failing boot.

**Changed.**

- *Ownership.* Above. The `COPY --chown` flags are gone; the smoke test asks the kernel, as the
  image's own user, whether `/app` is writable.
- *Package managers and headers.* `npm`, `npx`, `corepack`, `yarn` and Node's C++ headers shipped
  from the base image, and nothing in the entrypoint, the CMD or the healthcheck runs them. Removed.
  Honestly measured: the removal is a whiteout over base layers that still ship, so the pull is not
  smaller — this buys attack surface and scanner noise, not bytes. The alternative that would buy
  bytes (`FROM alpine` plus a copied `node` binary) was rejected as owning the Node install.
- *Install scripts in the build.* `npm ci` in the `deps` stage ran every dependency's install hook
  while CI's audit job refused to. The lockfile's only Linux hook is esbuild's, whose work Vite's JS
  API never uses; a build without scripts is byte-identical (the whole `build/` tree compared).
- *Dead code from the price client's dependency.* Two more packages met the prune script's own rule
  (reached only from the CLI bins and the Deno import map), and the CLI, MCP-transport and vendored
  Deno standard-library sources the cut edges existed for were still on disk. All inert, all gone.
- *Build scratch.* npm's install-time inventory, written before the Dockerfile's later removals and
  describing packages that were no longer there; Vite's temp directory; the emptied scope
  directories that read as decoys. Gone. `package.json` now ships only what the runtime reads —
  the `scripts` block with its test-database URL and the dev toolchain's version list do not.
- *The syntax directive.* The one build input BuildKit downloads and executes by floating tag, for
  features this Dockerfile does not use. Removed; the header says what would bring it back.

**Rejected.** Trimming type declarations, sourcemaps and READMEs inside `node_modules` (a fourth
hand-patch of the tree for a small fraction of the image, and sourcemap removal changes dependency
stack traces); deleting busybox applets (theatre — the multi-call binary still answers); the
duplicate `react-router` production build that its own exports map never names (upstream
packaging).

## 2. The build context

`.dockerignore` is a denylist, and it did not name `allowed-emails.txt` — the household's real
Google addresses, which the documentation tells the operator to create at the context root. Under
BuildKit only `COPY`-matched contents are transferred, so it reached no image; the file's own header
claimed more than that. The name is now listed, with `.agents`, `.npmrc`, `compose.override.yaml`
and root-level patch files; the header states what the list guarantees. Converting to an allowlist
was rejected: the context is small, every `COPY` is selective, and negated recursion is easier to
get wrong. A stray, already-applied patch file that was tracked at the root is deleted.

## 3. What the running container does

**Verified sound.** No sourcemaps anywhere outside `node_modules`; no directory listings; traversal
attempts in eight encodings refused; no framework fingerprint header; the open-redirect guard holds;
error pages and error payloads disclose nothing with the database down, and recovery is clean;
`/healthz` is the only path the gate exempts; the process holds exactly two sockets (its listener
and one Postgres connection) before, during and after a full statement upload; nothing is spooled to
`/tmp`; the service worker stores nothing; no CDN, font or analytics host anywhere in the client.

**Changed.**

- *Caching.* Every rendered page and single-fetch payload left with no cache directive. Masking is
  a display state, so a masked page still carries every figure — a cached page is the household's
  finances on a shared device's disk or in the house proxy. The root route now sends `no-store`,
  which every route inherits; ADR-0007 records the consequence.
- *Egress.* The price client's default `versionCheck` fetches the npm registry on any quote that
  fails its schema — a second destination the operating guide said did not exist. Off now, with
  the survey banner suppressed. The guide also understated the first destination: the provider is
  one party but four hostnames, reached the way a browser reaches them, including a consent POST
  on the household's behalf and cookies replayed for the life of the process. Documented.
- *Logs.* Request lines carry the query string (the owner filter and account ids — never headers,
  addresses or bodies); a provider HTTP error prints the request URL with every symbol in the batch;
  a 404 logs a framework stack. None has a knob; all three are documented so a log is redacted
  before it is shared.

## 4. What the image is exposed to

Two `qs` advisories — availability-only, but on the path every request takes and reachable without
the gate — shipped in the image, twelve days after the previous audit reported zero. Express 4 pins a
`qs` range one minor short of the fix, so `npm audit fix` moves nothing; an `overrides` entry moves
exactly one lockfile entry. The CI gate ran at `high` and went green over them; it now fails from
moderate up for the production tree.

**Pinning, assessed and left alone.** The base images float on purpose and the case is now written
in the Dockerfile header: a release picks up the current patched Node and Alpine, and a digest pin
would hold OpenSSL and busybox still with nothing in this repository to bump it — the audit found the
base image one OpenSSL patch behind, on a library nothing in the container calls, fixed by exactly
that mechanism. The same argument leaves the workflow actions on major tags. An image scanner in CI
was recommended against for now: on this image its whole OS-layer output would be that unfixable-
here gap, and a gate red for reasons nobody can act on gets ignored.

## 5. Recommended, not done

- **Provenance for the published image**, via `actions/attest-build-provenance`: stores a signed
  SLSA statement in GitHub's attestation API with `push-to-registry` off, so GHCR's manifest list —
  and its rendering — are untouched, and an operator can `gh attestation verify` a tag before an
  upgrade. Four lines of YAML and two job permissions; the owner's call because it widens the
  publish job's permissions. BuildKit's own `provenance: mode=min` is not a middle ground: it adds
  the attestation manifest GHCR misrenders, and the privacy reason for keeping BuildKit provenance
  off is now in the workflow's comment.
- **Pin the publish job's actions to commit SHAs**, only alongside something that bumps them.
- **A bodyless `POST` to any action route answers 500** rather than the domain's own refusal (a bare
  `TypeError` from reading the form). No disclosure; against the rule that refusals are data.
  Reproduce with `curl -X POST` at the container's `/refresh`. Belongs in the issue tracker.
- **Upstream**, on the price client: its bare `console.error` of the full request URL on an HTTP
  error is what puts the symbol list in the log.
- `docker stop` drains for most of the grace period when a keep-alive client is connected; exit 0,
  nothing lost. Worth `stop_grace_period` only if exit 137 ever appears in the logs.
