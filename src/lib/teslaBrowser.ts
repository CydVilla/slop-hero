/**
 * Tesla in-car browser detection.
 *
 * The Tesla browser has no usable file picker or drag-and-drop, so anything that
 * relies on uploading a local file is pointless there. We detect it from the
 * User-Agent so we can hide upload entry points.
 *
 * Identifiers:
 *  - "Tesla"        — Chromium-based browser on MCU2/MCU3 (Model 3/Y, newer S/X)
 *  - "QtCarBrowser" — the older WebKit browser on MCU1
 *
 * This is a pure function (no DOM) so it can run on the server from the
 * request's User-Agent header, which avoids a flash of the upload button before
 * client-side detection would kick in.
 */
export const TESLA_UA_REGEX = /Tesla|QtCarBrowser/i;

export function isTeslaUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && TESLA_UA_REGEX.test(userAgent);
}
