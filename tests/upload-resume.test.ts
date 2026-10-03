// A wizard redirect that drops `?stale=true` fails silently: the reader lands on the right step without the "review went
// stale" warning. resumeAt is the one spelling of that redirect, staleOf the one reader of the flag (spec 0031).
import { describe, expect, it } from "vitest";

import { resumeAt, staleOf } from "~/lib/upload-resume.server";

import type { ResumeStep } from "~/lib/upload-resume.server";

describe("resumeAt", () => {
  it.each<{ step: ResumeStep; stale: boolean; location: string }>([
    { step: "columns", stale: false, location: "/upload/7/columns" },
    { step: "accounts", stale: false, location: "/upload/7/accounts" },
    { step: "instruments", stale: false, location: "/upload/7/instruments" },
    { step: "review", stale: false, location: "/upload/7/review" },
    { step: null, stale: false, location: "/upload/7/review" },
    { step: "columns", stale: true, location: "/upload/7/columns?stale=true" },
    { step: "accounts", stale: true, location: "/upload/7/accounts?stale=true" },
    { step: "instruments", stale: true, location: "/upload/7/instruments?stale=true" },
    { step: "review", stale: true, location: "/upload/7/review?stale=true" },
    { step: null, stale: true, location: "/upload/7/review?stale=true" },
  ])(
    "redirects step $step with stale $stale to $location",
    ({ step, stale, location }) => {
      const response = resumeAt("7", step, stale);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(location);
    },
  );
});

describe("staleOf", () => {
  it.each([
    { search: "?stale=true", stale: true },
    { search: "?asOf=2026-06-30&stale=true", stale: true },
    { search: "", stale: false },
    { search: "?stale=1", stale: false },
    { search: "?stale=TRUE", stale: false },
    { search: "?stale=false", stale: false },
  ])("reads $search as stale $stale", ({ search, stale }) => {
    expect(staleOf(new Request(`http://localhost/upload/7/review${search}`))).toBe(stale);
  });
});
