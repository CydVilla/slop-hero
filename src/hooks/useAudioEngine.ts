"use client";

/**
 * useAudioEngine
 *
 * Thin React wrapper around the Web Audio API that acts as the game's timing
 * source. The actual clock is `AudioContext.currentTime`, which is a precise,
 * monotonic, audio-thread-backed clock — far more reliable for rhythm timing
 * than performance.now() / Date.now().
 *
 * Two modes share ONE clock model:
 *   - Audio mode: a decoded AudioBuffer is played; position is derived from the
 *     context clock relative to when playback started.
 *   - Silent/demo mode: no buffer is loaded, but the same context-clock math
 *     advances time so a chart can scroll with no audio file present.
 *
 * The high-frequency time read (`getTimeMs`) never touches React state, so the
 * render loop can poll it every frame without triggering re-renders. Only
 * low-frequency facts (status, duration, playing flag) live in React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AudioEngineStatus = "empty" | "loading" | "ready";

export interface AudioEngine {
  status: AudioEngineStatus;
  isPlaying: boolean;
  durationMs: number;
  /** Decode and load audio from an object URL. Resolves with duration in ms. */
  loadFromUrl: (url: string) => Promise<number>;
  /** Switch to silent/demo mode with a fixed duration (ms). */
  loadSilent: (durationMs: number) => void;
  /**
   * Resume (unlock) the underlying AudioContext. MUST be called from within a
   * user-gesture handler — browsers refuse to start/resume audio otherwise, and
   * a suspended context's clock never advances. Safe to call repeatedly.
   */
  resume: () => Promise<void>;
  /** Start (or resume) playback from an optional position in ms. */
  play: (fromMs?: number) => Promise<void>;
  pause: () => void;
  stop: () => void;
  /** Current playback position in ms. Safe to call every animation frame. */
  getTimeMs: () => number;
  setVolume: (value: number) => void;
}

interface InternalState {
  ctx: AudioContext | null;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  /** Context time (s) at which the current playback segment started. */
  startedAtCtx: number;
  /** Song position (ms) corresponding to startedAtCtx. */
  startOffsetMs: number;
  playing: boolean;
  /** Position to report while paused/stopped. */
  pausedAtMs: number;
  durationMs: number;
  /** True when running without a real buffer (demo mode). */
  silent: boolean;
}

function getOrCreateContext(state: InternalState): AudioContext {
  if (!state.ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    state.ctx = new Ctor();
    state.gain = state.ctx.createGain();
    state.gain.connect(state.ctx.destination);
  }
  return state.ctx;
}

export function useAudioEngine(): AudioEngine {
  const ref = useRef<InternalState>({
    ctx: null,
    buffer: null,
    source: null,
    gain: null,
    startedAtCtx: 0,
    startOffsetMs: 0,
    playing: false,
    pausedAtMs: 0,
    durationMs: 0,
    silent: false,
  });

  const [status, setStatus] = useState<AudioEngineStatus>("empty");
  const [isPlaying, setIsPlaying] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  const getTimeMs = useCallback((): number => {
    const s = ref.current;
    if (!s.playing || !s.ctx) return s.pausedAtMs;
    const elapsedMs = (s.ctx.currentTime - s.startedAtCtx) * 1000;
    const pos = s.startOffsetMs + elapsedMs;
    // Clamp at duration so we never report past the end.
    return s.durationMs > 0 ? Math.min(pos, s.durationMs) : pos;
  }, []);

  const stopSource = useCallback(() => {
    const s = ref.current;
    if (s.source) {
      try {
        s.source.onended = null;
        s.source.stop();
      } catch {
        // Already stopped; ignore.
      }
      s.source.disconnect();
      s.source = null;
    }
  }, []);

  const loadFromUrl = useCallback(
    async (url: string): Promise<number> => {
      setStatus("loading");
      const s = ref.current;
      const ctx = getOrCreateContext(s);
      const res = await fetch(url);
      const arrayBuffer = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      s.buffer = buffer;
      s.silent = false;
      s.durationMs = buffer.duration * 1000;
      s.pausedAtMs = 0;
      s.playing = false;
      setDurationMs(s.durationMs);
      setStatus("ready");
      setIsPlaying(false);
      return s.durationMs;
    },
    [],
  );

  const loadSilent = useCallback((durMs: number) => {
    const s = ref.current;
    getOrCreateContext(s);
    s.buffer = null;
    s.silent = true;
    s.durationMs = durMs;
    s.pausedAtMs = 0;
    s.playing = false;
    setDurationMs(durMs);
    setStatus("ready");
    setIsPlaying(false);
  }, []);

  const resume = useCallback(async (): Promise<void> => {
    const s = ref.current;
    const ctx = getOrCreateContext(s);
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Resume can reject if not called from a gesture; the next gesture retries.
      }
    }
  }, []);

  const play = useCallback(
    async (fromMs?: number): Promise<void> => {
      const s = ref.current;
      const ctx = getOrCreateContext(s);
      // AudioContext starts suspended until a user gesture resumes it.
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const startMs = fromMs ?? s.pausedAtMs;

      stopSource();

      if (!s.silent && s.buffer && s.gain) {
        const source = ctx.createBufferSource();
        source.buffer = s.buffer;
        source.connect(s.gain);
        source.onended = () => {
          // Only treat as natural end if we're still nominally playing.
          if (ref.current.playing) {
            ref.current.playing = false;
            ref.current.pausedAtMs = ref.current.durationMs;
            setIsPlaying(false);
          }
        };
        source.start(0, startMs / 1000);
        s.source = source;
      }

      s.startedAtCtx = ctx.currentTime;
      s.startOffsetMs = startMs;
      s.playing = true;
      setIsPlaying(true);
    },
    [stopSource],
  );

  const pause = useCallback(() => {
    const s = ref.current;
    if (!s.playing) return;
    s.pausedAtMs = getTimeMs();
    s.playing = false;
    stopSource();
    setIsPlaying(false);
  }, [getTimeMs, stopSource]);

  const stop = useCallback(() => {
    const s = ref.current;
    s.playing = false;
    s.pausedAtMs = 0;
    stopSource();
    setIsPlaying(false);
  }, [stopSource]);

  const setVolume = useCallback((value: number) => {
    const s = ref.current;
    if (s.gain && s.ctx) {
      s.gain.gain.setValueAtTime(value, s.ctx.currentTime);
    }
  }, []);

  // Tear down the AudioContext on unmount to avoid leaking audio nodes.
  useEffect(() => {
    const stateRef = ref;
    return () => {
      const s = stateRef.current;
      if (s.source) {
        try {
          s.source.stop();
        } catch {
          // ignore
        }
      }
      if (s.ctx) {
        void s.ctx.close();
        s.ctx = null;
      }
    };
  }, []);

  // Memoize so the engine object identity is stable across renders (it only
  // changes when the low-frequency reactive values change). This keeps effects
  // in consuming hooks from re-subscribing on every render.
  return useMemo<AudioEngine>(
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
    [
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
    ],
  );
}
