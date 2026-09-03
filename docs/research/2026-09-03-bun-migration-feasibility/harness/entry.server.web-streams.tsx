// The Web-streams server entry the Bun spike ran behind. NOT part of the app:
// this repository has no `app/entry.server.tsx` and uses React Router's default
// Node entry. To reproduce blocker one's fix, `npx react-router reveal` and then
// replace the generated `app/entry.server.tsx` with this file.
//
// The point of it is `renderToReadableStream` in place of the default entry's
// `renderToPipeableStream`, which React 19's `bun` export condition does not
// provide. React's Node build exports both, which is why this is neutral on Node.
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  let shellError = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), streamTimeout + 1_000);

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: controller.signal,
      onError(error: unknown) {
        if (!shellError) responseStatusCode = 500;
        console.error(error);
      },
    },
  );
  shellError = true;

  const userAgent = request.headers.get("user-agent");
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await stream.allReady;
  }

  stream.allReady.finally(() => { clearTimeout(timer); });

  responseHeaders.set("Content-Type", "text/html");
  return new Response(stream, { headers: responseHeaders, status: responseStatusCode });
}
