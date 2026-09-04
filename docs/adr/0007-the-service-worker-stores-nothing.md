# The service worker stores nothing on the device

The PWA slice (docs/specs/0012) makes the app installable on the household's phones, and a phone is
off the VPN most of the time — which makes the obvious next move caching: a service worker that
keeps the last-known screens so net worth is glanceable from anywhere. That is the design every PWA
tutorial reaches for, and it was considered and refused. The worker this application ships is
network-only: it opens no Cache Storage, touches no IndexedDB, and its offline page is a template
string inside the worker script itself. Nothing the server ever said is retained on the device.

The reason is where the boundary actually sits. The gate is the household's one boundary, and it
protects the *server*: every request is challenged, nothing is reachable without the VPN and a
signed-in session. A cache on a phone sits outside that boundary entirely — it is readable by
whoever holds the unlocked phone, it survives the VPN disconnecting, and it cannot be revoked from
the server side. Masking (ADR-0002) is deliberately weak and says so; a cache would be the same
kind of weakness without the honesty. The household's answer to "may balances persist on family
phones?" was no, and this ADR is that answer written down.

The refusal is structural, not disciplined: because the offline page is inlined, the worker has no
precache list, no cache version, no activation cleanup — there is no caching machinery to hold
correct, and a reviewer verifies the rule by reading one short file. The one behavioral subtlety
worth recording: the worker answers a failed navigation fetch, and only a *rejected* one. The
gate's 302 to sign-in resolves as an `opaqueredirect` (with `ok === false`) that the browser
follows itself — so the worker must never branch on `response.ok`, or sign-in breaks.

## Considered options

**Cache the last-known screens (read-only snapshot).** The genuinely useful offline experience for
a tracker, and the reason a PWA usually carries a worker at all. Rejected as a values call: the
figures would persist outside the gate's boundary on every family phone, and the household chose
the clean device over the glanceable snapshot.

**Precache a static offline page.** The textbook shape — a small cache holding one page and its
assets. Rejected because inlining the page in the worker deletes the precache list, the cache
version and the activation cleanup wholesale, and turns "stores nothing" from a property someone
maintains into a property the code cannot lose quietly.

**No service worker at all.** Installability no longer requires one, so the manifest alone would
do. Rejected because the failure state is then Chrome's error screen — and for an app that is
unreachable most of the day on mobile, the branded "connect the VPN" page *is* the offline
feature.

## Consequences

- **Offline, the app shows guidance and nothing else.** No figures, no stale chart, no cached
  shell. The offline page must stay a nicety, never a dependency — Android may evict a rarely-used
  registration, and losing it costs only the branding until the next visit.
- **The browser's own cache is held to the same rule.** Every rendered page and loader payload is
  sent `Cache-Control: no-store` (the root route's `headers` export), because a page carries every
  figure whether or not it is masked (ADR-0002) and the disk cache — or the house proxy in front —
  is a cache outside the boundary by another route. The price is that Back on Firefox and Safari
  re-fetches through the gate instead of restoring the page.
- **The worker must stay small enough to audit by eye.** Its rule has no test harness; review and
  a tripwire test (no `caches.open`, no `indexedDB` in the file) are the enforcement. A change
  that makes the worker hard to read in one sitting has already broken the rule's enforcement.
- **Never branch on `response.ok` for navigations.** An `opaqueredirect` from the gate has
  `ok === false`; "improving" the fallback to catch non-OK responses breaks sign-in.
- **Revisiting means a new ADR, and slowly.** Workers update on the phones only when the server is
  reachable and the session live; a caching decision shipped by mistake cannot be clawed back
  quickly. The trade-off above is the starting point for any future offline-snapshot idea.
