"use client";

/**
 * useRhythmGame
 *
 * Orchestration layer that sits between the pure engine (scoring/timing) and
 * the React UI. It owns gameplay transitions (start/pause/restart), applies tap
 * results, and detects missed notes each frame.
 *
 * Boundary rules this hook respects:
 *  - All gameplay RULES live in ../game/* pure modules; this hook only wires
 *    them to React state and to the audio clock.
 *  - High-frequency data the canvas reads every frame (per-note runtime state,
 *    feedback list, lane flashes) lives in REFS, never React state, so the
 *    animation loop does not trigger re-renders.
 *  - Low-frequency UI data (score, phase, calibration) lives in React state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COUNTDOWN_MS, FEEDBACK_DURATION_MS } from "@/game/constants";
import { createRuntimeState, makeNoteId, chartDurationMs } from "@/game/chartUtils";
import {
  applyHit,
  applyMiss,
  createInitialScore,
  findNewlyMissedNoteIds,
  isComplete,
  resolveTap,
} from "@/game/scoring";
import type {
  GamePhase,
  HitFeedback,
  Lane,
  NoteRuntimeState,
  RhythmChart,
  ScoreState,
} from "@/game/types";

/** Minimal audio surface the game needs; keeps the hooks loosely coupled. */
export interface GameAudioControls {
  play: (fromMs?: number) => Promise<void> | void;
  pause: () => void;
  stop: () => void;
  getTimeMs: () => number;
}

export interface RhythmGame {
  phase: GamePhase;
  score: ScoreState;
  /**
   * Seconds remaining in the pre-song countdown (3, 2, 1). Only meaningful while
   * `phase === "countdown"`; 0 otherwise.
   */
  countdown: number;
  calibrationOffsetMs: number;
  /** Refs consumed by the renderer (do not read in JSX render path). */
  runtimeRef: React.RefObject<Map<string, NoteRuntimeState>>;
  feedbackRef: React.RefObject<HitFeedback[]>;
  laneFlashRef: React.RefObject<Record<Lane, number>>;
  /** Read latest calibration without going through React state (for canvas). */
  getCalibrationOffsetMs: () => number;

  start: () => void;
  togglePause: () => void;
  restart: () => void;
  tapLane: (lane: Lane) => void;
  /** Called once per animation frame with the current song time (ms). */
  update: (songTimeMs: number) => void;

  adjustCalibration: (deltaMs: number) => void;
  resetCalibration: () => void;
}

function emptyLaneFlash(): Record<Lane, number> {
  return { 0: -Infinity, 1: -Infinity, 2: -Infinity, 3: -Infinity, 4: -Infinity };
}

export function useRhythmGame(
  chart: RhythmChart,
  audio: GameAudioControls,
): RhythmGame {
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState<ScoreState>(() =>
    createInitialScore(chart.notes.length),
  );
  const [countdown, setCountdown] = useState(0);
  const [calibrationOffsetMs, setCalibrationOffsetMs] = useState(0);

  // Pending interval id for the pre-song countdown, so we can cancel it if the
  // player restarts/pauses mid-count or the component unmounts.
  const countdownTimerRef = useRef<number | null>(null);

  const runtimeRef = useRef<Map<string, NoteRuntimeState>>(
    createRuntimeState(chart),
  );
  const feedbackRef = useRef<HitFeedback[]>([]);
  const laneFlashRef = useRef<Record<Lane, number>>(emptyLaneFlash());

  // Mirror values that tap/update read at high frequency to avoid stale closures.
  const phaseRef = useRef<GamePhase>("idle");
  const calibrationRef = useRef(0);
  const durationRef = useRef(chartDurationMs(chart));

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    calibrationRef.current = calibrationOffsetMs;
  }, [calibrationOffsetMs]);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  // Re-initialise everything when the chart instance changes.
  useEffect(() => {
    clearCountdownTimer();
    runtimeRef.current = createRuntimeState(chart);
    feedbackRef.current = [];
    laneFlashRef.current = emptyLaneFlash();
    durationRef.current = chartDurationMs(chart);
    setScore(createInitialScore(chart.notes.length));
    setCountdown(0);
    setPhase("idle");
  }, [chart, clearCountdownTimer]);

  // Cancel any in-flight countdown when the hook unmounts.
  useEffect(() => clearCountdownTimer, [clearCountdownTimer]);

  const getCalibrationOffsetMs = useCallback(() => calibrationRef.current, []);

  const pushFeedback = useCallback(
    (lane: Lane, rating: HitFeedback["rating"], atMs: number, errorMs: number) => {
      const list = feedbackRef.current;
      // Prune expired entries opportunistically so the array stays small.
      const cutoff = atMs - FEEDBACK_DURATION_MS;
      const pruned =
        list.length > 24 ? list.filter((f) => f.createdAtMs >= cutoff) : list;
      pruned.push({
        id: makeNoteId("fb"),
        lane,
        rating,
        createdAtMs: atMs,
        errorMs,
      });
      feedbackRef.current = pruned;
    },
    [],
  );

  const resetGameState = useCallback(() => {
    runtimeRef.current = createRuntimeState(chart);
    feedbackRef.current = [];
    laneFlashRef.current = emptyLaneFlash();
    setScore(createInitialScore(chart.notes.length));
  }, [chart]);

  // Run a short "3, 2, 1" countdown, then start the song from the top. This
  // gives the player a beat to get ready so the opening notes aren't missed the
  // instant they tap Start. Audio only begins once the count hits zero.
  const beginCountdown = useCallback(() => {
    clearCountdownTimer();
    audio.stop();
    resetGameState();

    let remaining = Math.max(1, Math.round(COUNTDOWN_MS / 1000));
    setCountdown(remaining);
    setPhase("countdown");

    countdownTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdownTimer();
        setCountdown(0);
        setPhase("playing");
        void audio.play(0);
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, [audio, resetGameState, clearCountdownTimer]);

  const start = useCallback(() => {
    beginCountdown();
  }, [beginCountdown]);

  const restart = useCallback(() => {
    beginCountdown();
  }, [beginCountdown]);

  const togglePause = useCallback(() => {
    // Branch on the ref (avoids nesting side-effects inside a setState updater).
    const current = phaseRef.current;
    if (current === "playing") {
      audio.pause();
      setPhase("paused");
    } else if (current === "paused") {
      void audio.play();
      setPhase("playing");
    } else if (current === "countdown") {
      // Cancel the countdown and return to the ready screen.
      clearCountdownTimer();
      audio.stop();
      setCountdown(0);
      setPhase("idle");
    } else if (current === "idle" || current === "finished") {
      // Treat as a fresh start (with the same countdown).
      beginCountdown();
    }
  }, [audio, beginCountdown, clearCountdownTimer]);

  const tapLane = useCallback(
    (lane: Lane) => {
      if (phaseRef.current !== "playing") return;
      const t = audio.getTimeMs();
      laneFlashRef.current[lane] = t;

      const result = resolveTap(
        chart.notes,
        runtimeRef.current,
        lane,
        t,
        chart.offsetMs,
        calibrationRef.current,
      );

      if (result.kind === "hit") {
        runtimeRef.current.set(result.note.id, {
          judged: true,
          rating: result.rating,
          judgedAtMs: t,
        });
        setScore((s) => applyHit(s, result.rating));
        pushFeedback(lane, result.rating, t, result.errorMs);
      }
      // Stray taps (no note in window) are intentionally forgiving on a
      // touchscreen: they flash the lane but do not break combo.
    },
    [audio, chart.notes, chart.offsetMs, pushFeedback],
  );

  const update = useCallback(
    (songTimeMs: number) => {
      if (phaseRef.current !== "playing") return;

      const missedIds = findNewlyMissedNoteIds(
        chart.notes,
        runtimeRef.current,
        songTimeMs,
        chart.offsetMs,
        calibrationRef.current,
      );

      if (missedIds.length > 0) {
        for (const id of missedIds) {
          const note = chart.notes.find((n) => n.id === id);
          runtimeRef.current.set(id, {
            judged: true,
            rating: "miss",
            judgedAtMs: songTimeMs,
          });
          if (note) {
            pushFeedback(note.lane, "miss", songTimeMs, 0);
          }
        }
        setScore((s) =>
          missedIds.reduce((acc) => applyMiss(acc), s),
        );
      }

      // End the run once the song is over (covers trailing silence too).
      if (durationRef.current > 0 && songTimeMs >= durationRef.current + 250) {
        setPhase("finished");
        audio.stop();
      }
    },
    [audio, chart.notes, chart.offsetMs, pushFeedback],
  );

  // Finish as soon as every note has been judged.
  useEffect(() => {
    if (phase === "playing" && isComplete(score)) {
      setPhase("finished");
      audio.stop();
    }
  }, [phase, score, audio]);

  const adjustCalibration = useCallback((deltaMs: number) => {
    setCalibrationOffsetMs((prev) => prev + deltaMs);
  }, []);

  const resetCalibration = useCallback(() => setCalibrationOffsetMs(0), []);

  return useMemo<RhythmGame>(
    () => ({
      phase,
      score,
      countdown,
      calibrationOffsetMs,
      runtimeRef,
      feedbackRef,
      laneFlashRef,
      getCalibrationOffsetMs,
      start,
      togglePause,
      restart,
      tapLane,
      update,
      adjustCalibration,
      resetCalibration,
    }),
    [
      phase,
      score,
      countdown,
      calibrationOffsetMs,
      getCalibrationOffsetMs,
      start,
      togglePause,
      restart,
      tapLane,
      update,
      adjustCalibration,
      resetCalibration,
    ],
  );
}
