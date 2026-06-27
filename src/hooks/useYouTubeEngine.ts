"use client";

/**
 * useYouTubeEngine
 *
 * A drop-in alternative to useAudioEngine that uses an embedded YouTube video as
 * both the sound source and the timing source, exposing the SAME `AudioEngine`
 * interface so the game loop doesn't care which one it's driving.
 *
 * Why embed (and not extract): browsers can't read PCM out of a cross-origin
 * YouTube iframe, and extracting audio violates YouTube's ToS. The official
 * IFrame Player API is the sanctioned path. The trade-off is timing: the
 * player's getCurrentTime() updates coarsely, so we interpolate with
 * performance.now() between polls and only re-anchor when drift gets large. This
 * is good for a casual feel but not as tight as Web Audio (lean on calibration).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioEngine, AudioEngineStatus } from "./useAudioEngine";

/* ----------------------------- Minimal YT typings ------------------------- */

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setVolume(volume: number): void;
  destroy(): void;
}

interface YTStateChangeEvent {
  target: YTPlayer;
  data: number;
}

interface YTReadyEvent {
  target: YTPlayer;
}

interface YTPlayerOptions {
  videoId: string;
  playerVars?: Record<string, number | string>;
  events?: {
    onReady?: (e: YTReadyEvent) => void;
    onStateChange?: (e: YTStateChangeEvent) => void;
  };
}

interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/* --------------------------- IFrame API loader ---------------------------- */

let apiPromise: Promise<void> | null = null;

function loadIframeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

/* -------------------------------- The hook -------------------------------- */

export interface YouTubeEngine {
  engine: AudioEngine;
  /** Mount point for the (required, visible) player iframe. */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/** Re-anchor the interpolated clock only when it drifts past this (ms). */
const DRIFT_TOLERANCE_MS = 80;

export function useYouTubeEngine(videoId?: string): YouTubeEngine {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);

  const [status, setStatus] = useState<AudioEngineStatus>("empty");
  const [isPlaying, setIsPlaying] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  // Interpolation anchor: time (anchorMs) we believe the song was at, captured
  // at performance.now()===anchorPerf. While playing, getTimeMs extrapolates.
  const anchor = useRef({ anchorMs: 0, anchorPerf: 0, playing: false });

  // Create the player when we have a video id, the API, and a mount node.
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    setStatus("loading");

    void loadIframeApi().then(() => {
      if (cancelled || !containerRef.current || !window.YT) return;
      // Mount into a child node so YT can replace it without fighting React over
      // the ref'd container element.
      const mount = document.createElement("div");
      containerRef.current.appendChild(mount);

      playerRef.current = new window.YT.Player(mount, {
        videoId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          fs: 0,
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            setDurationMs((e.target.getDuration() || 0) * 1000);
            setStatus("ready");
          },
          onStateChange: (e) => {
            const states = window.YT?.PlayerState;
            if (!states) return;
            if (e.data === states.PLAYING) {
              anchor.current = {
                anchorMs: e.target.getCurrentTime() * 1000,
                anchorPerf: performance.now(),
                playing: true,
              };
              setIsPlaying(true);
            } else if (e.data === states.PAUSED) {
              anchor.current = {
                anchorMs: e.target.getCurrentTime() * 1000,
                anchorPerf: performance.now(),
                playing: false,
              };
              setIsPlaying(false);
            } else if (e.data === states.ENDED) {
              anchor.current.playing = false;
              setIsPlaying(false);
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        /* player already gone */
      }
      playerRef.current = null;
      setStatus("empty");
      setIsPlaying(false);
    };
  }, [videoId]);

  // Periodically correct interpolation drift against the real player clock.
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current;
      const a = anchor.current;
      if (!p || !a.playing) return;
      const real = p.getCurrentTime() * 1000;
      const interpolated = a.anchorMs + (performance.now() - a.anchorPerf);
      if (Math.abs(interpolated - real) > DRIFT_TOLERANCE_MS) {
        anchor.current = { anchorMs: real, anchorPerf: performance.now(), playing: true };
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const getTimeMs = useCallback((): number => {
    const a = anchor.current;
    if (!a.playing) return a.anchorMs;
    return a.anchorMs + (performance.now() - a.anchorPerf);
  }, []);

  // No-op: the YouTube player is unlocked by its own playVideo() call, which is
  // already invoked from a user gesture. Present so the engine matches the
  // shared AudioEngine interface.
  const resume = useCallback(async (): Promise<void> => {}, []);

  const play = useCallback(async (fromMs?: number): Promise<void> => {
    const p = playerRef.current;
    if (!p) return;
    if (fromMs !== undefined) {
      p.seekTo(fromMs / 1000, true);
      anchor.current = { anchorMs: fromMs, anchorPerf: performance.now(), playing: true };
    }
    p.playVideo();
  }, []);

  const pause = useCallback((): void => {
    playerRef.current?.pauseVideo();
  }, []);

  const stop = useCallback((): void => {
    const p = playerRef.current;
    if (p) {
      try {
        p.pauseVideo();
        p.seekTo(0, true);
      } catch {
        /* ignore */
      }
    }
    anchor.current = { anchorMs: 0, anchorPerf: performance.now(), playing: false };
    setIsPlaying(false);
  }, []);

  const setVolume = useCallback((value: number): void => {
    playerRef.current?.setVolume(Math.round(value * 100));
  }, []);

  // loadFromUrl/loadSilent are part of the interface but unused here — the player
  // self-loads from the video id. Kept as no-ops so the shape matches.
  const loadFromUrl = useCallback(async (): Promise<number> => durationMs, [durationMs]);
  const loadSilent = useCallback((): void => {}, []);

  const engine = useMemo<AudioEngine>(
    () => ({
      status,
      isPlaying,
      durationMs,
      loadFromUrl,
      loadSilent,
      resume,
      play,
      pause,
      stop,
      getTimeMs,
      setVolume,
    }),
    [status, isPlaying, durationMs, loadFromUrl, loadSilent, resume, play, pause, stop, getTimeMs, setVolume],
  );

  return { engine, containerRef };
}
