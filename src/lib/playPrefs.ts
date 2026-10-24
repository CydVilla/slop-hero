/**
 * Small per-device layout preferences for the play screen (localStorage).
 * Every read falls back to the default when storage is blocked or empty.
 */

export interface PlayPrefs {
  /** Book posture: which half of the hinge the highway takes. */
  highwaySide: "start" | "end";
  /** Tabletop posture: fret pads on the flat half instead of tapping the highway. */
  fretPad: boolean;
}

const KEY = "slop-hero:play-prefs";
const DEFAULTS: PlayPrefs = { highwaySide: "end", fretPad: true };

export function loadPlayPrefs(): PlayPrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<PlayPrefs>;
    return {
      highwaySide: raw.highwaySide === "start" ? "start" : DEFAULTS.highwaySide,
      fretPad: typeof raw.fretPad === "boolean" ? raw.fretPad : DEFAULTS.fretPad,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePlayPrefs(prefs: PlayPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked — the choice still applies for this visit.
  }
}

export const DEFAULT_PLAY_PREFS = DEFAULTS;
