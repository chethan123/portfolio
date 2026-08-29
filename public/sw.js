/*
 * The whole service worker, and deliberately the whole of it.
 *
 * It exists for one reason: when the server is unreachable — the phone is off
 * the VPN — a navigation lands on the branded page below instead of the
 * browser's error screen. It stores nothing: no Cache Storage, no IndexedDB;
 * the offline page is the template string right here (ADR-0007). Anything
 * that is not a GET navigation passes by untouched, so loaders, actions and
 * the upload flow's multipart posts never meet this file.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portfolio is unreachable</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f7f9fb; color: #1a1c1e;
    font: 16px/1.5 system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1326; color: #e2e2e6; }
  }
  main { text-align: center; padding: 24px; max-width: 26rem; }
  svg { width: 64px; height: 64px; }
  h1 { font-size: 20px; margin: 16px 0 8px; }
  p { margin: 0 0 20px; opacity: 0.75; }
  button {
    font: inherit; font-weight: 600; color: #ffffff; background: #0055ff;
    border: 0; border-radius: 999px; padding: 10px 24px;
  }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0055ff"/><path d="M23 47V19h10a9.5 9.5 0 0 1 0 19H23" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1>Portfolio is unreachable</h1>
  <p>This app lives on the home network. Connect the VPN — or get home — and try again.</p>
  <button onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  // Only a *rejected* fetch means unreachable. The gate answers a navigation
  // with a 302 this fetch resolves as an `opaqueredirect` — `ok === false` —
  // that the browser then follows itself. Branching on `response.ok` here
  // would swallow sign-in; never add it.
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
