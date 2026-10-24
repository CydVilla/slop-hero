/**
 * iOS audio session hint (Safari 16.4+ Audio Session API).
 *
 * On iPhone, Web Audio is muted by the Ring/Silent switch (or Silent mode on
 * the Action button) — while an <audio>/YouTube element is not. A rhythm game
 * whose song is silent is unplayable, so when we play a real song through Web
 * Audio we ask for the "playback" session: it ignores the silent switch and
 * takes over from other audio, like a music app. Silent/demo mode goes back to
 * "auto" so the player's own music keeps playing alongside the miss SFX.
 *
 * Browsers without `navigator.audioSession` (everything but WebKit) no-op.
 */

export type AudioSessionType = "auto" | "playback" | "ambient";

interface AudioSessionLike {
  type: string;
}

export function setAudioSessionType(type: AudioSessionType): void {
  if (typeof navigator === "undefined") return;
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (!session) return;
  try {
    if (session.type !== type) session.type = type;
  } catch {
    // Read-only or unsupported value — keep the browser default.
  }
}
