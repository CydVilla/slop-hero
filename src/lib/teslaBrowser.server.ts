import { headers } from "next/headers";

import { isTeslaUserAgent } from "./teslaBrowser";

/**
 * Detect the Tesla in-car browser from the request's User-Agent header.
 *
 * Call this in a Server Component (page/layout) and pass the result down as a
 * prop, so the correct value is baked into the first render — no client-side
 * flash of the upload button. Reading headers() opts the route into dynamic
 * rendering, which is what we want for per-request UA detection.
 */
export async function detectTeslaBrowser(): Promise<boolean> {
  return isTeslaUserAgent((await headers()).get("user-agent"));
}
