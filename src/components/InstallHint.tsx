"use client";

/**
 * InstallHint
 *
 * Nudges phone players to install the game to the home screen, where it runs
 * without browser chrome (see app/manifest.ts):
 *  - Chromium (Android, desktop): the browser's own install prompt, captured
 *    from `beforeinstallprompt` and fired from our button.
 *  - iPhone/iPad Safari: no install API, so a one-line Share-sheet how-to.
 *    Detected by `navigator.standalone`, which only iOS Safari defines.
 * Hidden once installed, and dismissible for good.
 */

import { useEffect, useState } from "react";

import styles from "./InstallHint.module.css";

const DISMISS_KEY = "slop-hero:install-hint-dismissed";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

type Hint = { kind: "prompt"; event: InstallPromptEvent } | { kind: "ios" } | null;

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function InstallHint({ className }: { className?: string }): React.JSX.Element | null {
  const [hint, setHint] = useState<Hint>(null);

  useEffect(() => {
    const installed = window.matchMedia(
      "(display-mode: standalone), (display-mode: fullscreen)",
    ).matches;
    if (installed || dismissed()) return;
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    if (iosStandalone === false) setHint({ kind: "ios" });

    const onPrompt = (e: Event) => {
      e.preventDefault(); // show our button instead of the mini-infobar
      setHint({ kind: "prompt", event: e as InstallPromptEvent });
    };
    const onInstalled = () => setHint(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!hint) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Can't remember — just hide it for this visit.
    }
    setHint(null);
  };

  return (
    <aside className={`${styles.hint} ${className ?? ""}`} aria-label="Install the game">
      {hint.kind === "prompt" ? (
        <>
          <span>Install Slop Hero for full-screen play.</span>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              void hint.event.prompt().finally(() => setHint(null));
            }}
          >
            Install
          </button>
        </>
      ) : (
        <span>
          Full-screen play: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.
        </span>
      )}
      <button type="button" className={styles.dismiss} onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </aside>
  );
}
