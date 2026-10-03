// The one shape a wizard route resumes a draft at (spec 0031). The warning that a review went stale
// rides only on `?stale=true`, and a dropped carry fails silently, so `stale` is required.
import { redirect } from "react-router";

import type { DraftParse } from "./uploads.server.ts";

export type ResumeStep = NonNullable<DraftParse["step"]> | "review" | null;

export function resumeAt(draftId: string, step: ResumeStep, stale: boolean): Response {
  return redirect(`/upload/${draftId}/${step ?? "review"}${stale ? "?stale=true" : ""}`);
}

export function staleOf(request: Request): boolean {
  return new URL(request.url).searchParams.get("stale") === "true";
}
