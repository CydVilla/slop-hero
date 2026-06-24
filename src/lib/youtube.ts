/**
 * YouTube link helpers (pure, no DOM).
 *
 * We only ever *embed* YouTube via the official IFrame Player API — we never
 * extract or rehost audio — so all we need from a user-pasted link is the 11-char
 * video id. Supports watch URLs, youtu.be short links, /embed, /shorts, /v, the
 * privacy-enhanced domain, and a bare id.
 */

const ID_RE = /^[\w-]{11}$/;

export function parseYouTubeId(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  if (ID_RE.test(s)) return s;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return ID_RE.test(id) ? id : null;
  }

  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const v = url.searchParams.get("v");
    if (v && ID_RE.test(v)) return v;
    const m = url.pathname.match(/\/(?:embed|shorts|v)\/([\w-]{11})/);
    if (m) return m[1] ?? null;
  }

  return null;
}

/** Parse a "m:ss" / "mm:ss" / bare-seconds string into seconds. */
export function parseLengthSeconds(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
