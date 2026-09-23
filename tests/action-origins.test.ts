import { describe, expect, it } from "vitest";

import { actionOriginsOf } from "../server/action-origins.ts";

describe("the origins allowed to submit an action", () => {
  it("names the host, not the origin, so a proxy terminating TLS does not refuse the app's own pages", () => {
    // The whole bug: the browser says https, the app behind the proxy says http. Matching on the
    // host is what makes those the same deployment.
    expect(actionOriginsOf("https://portfolio.example.com")).toEqual(["portfolio.example.com"]);
  });

  it("keeps the port, because a host with one is a different host to the framework", () => {
    expect(actionOriginsOf("http://localhost:5173")).toEqual(["localhost:5173"]);
  });

  it("admits the dev loop's plain-http origin on the same terms", () => {
    expect(actionOriginsOf("http://localhost")).toEqual(["localhost"]);
  });
});
