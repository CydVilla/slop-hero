"use client";

/**
 * useWakeLock
 *
 * Keeps the screen on while `active` (the countdown and the song). Long holds
 * and sparse sections can otherwise outlast a phone's auto-lock — on iPhone a
 * dimming screen mid-song is a guaranteed fail. Screen Wake Lock API: Chrome
 * 84+, Safari 16.4+ (home-screen web apps from 18.4). The browser drops the
 * lock whenever the page is hidden, so it's re-requested on return.
 * Unsupported browsers just no-op.
 */

import { useEffect } from "react";

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
}

interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return; // still held
      wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) void s.release().catch(() => undefined);
          else sentinel = s;
        })
        .catch(() => {
          // Denied (battery saver, permissions policy) — play on regardless.
        });
    };

    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
