/** One masking decision per React Router request; root and child loaders run in parallel. */
import { createContext, type RouterContextProvider } from "react-router";

import { readMaskingCookie, resolveMasked, type MaskingPolicy } from "./masking.ts";
import { readMaskingPolicy } from "./settings.server.ts";

export type RequestMasking = {
  masked: boolean;
  maskingPolicy: MaskingPolicy;
  /** False means the policy read failed and no browser cookie may weaken the fail-closed answer. */
  resolved: boolean;
};

const requestMaskingContext = createContext<Promise<RequestMasking> | null>(null);

async function resolveRequestMasking(request: Request): Promise<RequestMasking> {
  try {
    const maskingPolicy = await readMaskingPolicy();
    return {
      masked: resolveMasked(maskingPolicy, readMaskingCookie(request)),
      maskingPolicy,
      resolved: true,
    };
  } catch (error) {
    console.error("Masking policy read failed; masking this request:", error);
    return { masked: true, maskingPolicy: "masked", resolved: false };
  }
}

/** Set before awaiting so concurrently-started loaders share the same deferred read and outcome. */
export function maskingForRequest(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<RequestMasking> {
  const existing = context.get(requestMaskingContext);
  if (existing !== null) return existing;

  const resolving = resolveRequestMasking(request);
  context.set(requestMaskingContext, resolving);
  return resolving;
}
