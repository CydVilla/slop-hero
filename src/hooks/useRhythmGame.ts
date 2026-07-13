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

import { COUNTDOWN_MS, FEEDBACK_DURATION_MS, HIT_WINDOWS } from "@/game/constants";
import { defaultCalibrationOffsetMs } from "@/game/tuning";
import {
  createRuntimeState,
  makeNoteId,
  chartDurationMs,
  noteIndexRange,
  sortNotes,
} from "@/game/chartUtils";
import {
  applyHit,
  applyHoldComplete,
  applyHoldDrop,
  applyMiss,
  collectMissedFrom,
  createInitialScore,
  findCompletedHoldIds,
  isComplete,
  resolveRelease,
  resolveTap,
} from "@/game/scoring";
import {
  createRockMeter,
  isRockMeterFailed,
  rockMeterOnDrop,
  rockMeterOnHit,
  rockMeterOnMiss,
} from "@/game/rockMeter";
import {
  activateStarPower as spActivate,
  awardStarPhrase,
  buildPhraseIndex,
  createStarPower,
  registerStarNoteHit,
  registerStarNoteMiss,
  starPowerScoreMultiplier,
  tickStarPower,
} from "@/game/starPower";
import { playMissBuzz } from "@/lib/sfx";
import type {
  ChartNote,
  GamePhase,
  HitFeedback,
  Lane,
  NoteRuntimeState,
  RhythmChart,
  ScoreState,
  StarPhraseProgress,
  StarPowerState,
} from "@/game/types";

/** Minimal audio surface the game needs; keeps the hooks loosely coupled. */
export interface GameAudioControls {
  /**
   * Unlock/resume the audio clock. Called synchronously from the Start gesture
   * so the (otherwise suspended) AudioContext is running before the countdown's
   * timer fires play() — a deferred resume is blocked by browser autoplay rules.
   */
  resume?: () => Promise<void> | void;
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
  /**
   * Star power meter/activation state (low-frequency mirror, updated on
   * discrete events — awards, activation, depletion). The canvas reads
   * `starPowerRef` instead and derives the smooth drain per frame.
   */
  starPower: StarPowerState;
  /** Rock meter 0..1 — hits push it up, misses drag it down; empty = failed. */
  rockMeter: number;
  /** Refs consumed by the renderer (do not read in JSX render path). */
  runtimeRef: React.RefObject<Map<string, NoteRuntimeState>>;
  feedbackRef: React.RefObject<HitFeedback[]>;
  laneFlashRef: React.RefObject<Record<Lane, number>>;
  starPowerRef: React.RefObject<StarPowerState>;
  /** Read latest calibration without going through React state (for canvas). */
  getCalibrationOffsetMs: () => number;

  /**
   * Unleash banked star power (doubles scoring while it drains). No-op unless
   * playing with at least half a bar stored.
   */
  activateStarPower: () => void;

  start: () => void;
  togglePause: () => void;
  restart: () => void;
  /**
   * Press a lane (finger/key down). Judges the note at the hit line and, if it
   * is a sustain, begins holding its tail.
   */
  pressLane: (lane: Lane) => void;
  /**
   * Release a lane (finger/key up). Resolves any sustain being held there:
   * completing it if the tail is done, or dropping it (combo break) if early.
   */
  releaseLane: (lane: Lane) => void;
  /** @deprecated Use {@link pressLane}. Retained for callers that only tap. */
  tapLane: (lane: Lane) => void;
  /** Called once per animation frame with the current song time (ms). */
  update: (songTimeMs: number) => void;

  adjustCalibration: (deltaMs: number) => void;
  resetCalibration: () => void;
}

function emptyLaneFlash(): Record<Lane, number> {
  return { 0: -Infinity, 1: -Infinity, 2: -Infinity, 3: -Infinity, 4: -Infinity };
}

function notesById(chart: RhythmChart): Map<string, ChartNote> {
  const map = new Map<string, ChartNote>();
  for (const note of chart.notes) map.set(note.id, note);
  return map;
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
  // Seeded from the auto-tuned default so the loop can improve out-of-the-box
  // sync over time; players can still adjust it live.
  const [calibrationOffsetMs, setCalibrationOffsetMs] = useState(() =>
    defaultCalibrationOffsetMs(),
  );
  // Star power + rock meter: the REFS are authoritative (read and updated
  // inside the per-frame/per-tap hot paths); these states are display mirrors
  // written through commitStarPower/commitRockMeter on discrete events only.
  const [starPower, setStarPower] = useState<StarPowerState>(createStarPower);
  const [rockMeter, setRockMeter] = useState<number>(createRockMeter);

  // Pending interval id for the pre-song countdown, so we can cancel it if the
  // player restarts/pauses mid-count or the component unmounts.
  const countdownTimerRef = useRef<number | null>(null);

  const runtimeRef = useRef<Map<string, NoteRuntimeState>>(
    createRuntimeState(chart),
  );
  const notesByIdRef = useRef<Map<string, ChartNote>>(notesById(chart));
  // Notes sorted ascending by time. Every chart source already emits them in
  // order, but sorting here makes the binary-search windowing below correct by
  // construction regardless of source, at a one-time O(n log n) on chart load.
  const sortedNotesRef = useRef<ChartNote[]>(sortNotes(chart.notes));
  // Monotonic cursor into sortedNotesRef: all notes before it are past their
  // miss deadline (hence resolved). Advanced by collectMissedFrom each frame so
  // miss detection never re-scans the whole chart. Reset on (re)start.
  const missCursorRef = useRef(0);
  // Ids of holds whose head was hit and whose tail is still being held. Lets the
  // per-frame auto-complete check touch only live sustains instead of every note.
  const activeHoldsRef = useRef<Set<string>>(new Set());
  const feedbackRef = useRef<HitFeedback[]>([]);
  const laneFlashRef = useRef<Record<Lane, number>>(emptyLaneFlash());
  const starPowerRef = useRef<StarPowerState>(createStarPower());
  const rockMeterRef = useRef<number>(createRockMeter());
  // Star-phrase progress (phrase id → hit/broken counts), advanced as notes
  // resolve so a completed phrase can bank meter the instant its last note hits.
  const phraseIndexRef = useRef<Map<number, StarPhraseProgress>>(
    buildPhraseIndex(chart.notes),
  );

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
    notesByIdRef.current = notesById(chart);
    sortedNotesRef.current = sortNotes(chart.notes);
    missCursorRef.current = 0;
    activeHoldsRef.current.clear();
    feedbackRef.current = [];
    laneFlashRef.current = emptyLaneFlash();
    phraseIndexRef.current = buildPhraseIndex(chart.notes);
    durationRef.current = chartDurationMs(chart);
    setScore(createInitialScore(chart.notes.length));
    starPowerRef.current = createStarPower();
    setStarPower(starPowerRef.current);
    rockMeterRef.current = createRockMeter();
    setRockMeter(rockMeterRef.current);
    setCountdown(0);
    setPhase("idle");
  }, [chart, clearCountdownTimer]);

  // Cancel any in-flight countdown when the hook unmounts.
  useEffect(() => clearCountdownTimer, [clearCountdownTimer]);

  const getCalibrationOffsetMs = useCallback(() => calibrationRef.current, []);

  // Write-through setters: keep the authoritative ref and the low-frequency
  // React mirror in lockstep with a single call site.
  const commitStarPower = useCallback((next: StarPowerState) => {
    starPowerRef.current = next;
    setStarPower(next);
  }, []);

  const commitRockMeter = useCallback((next: number) => {
    rockMeterRef.current = next;
    setRockMeter(next);
  }, []);

  const pushFeedback = useCallback(
    (
      lane: Lane,
      rating: HitFeedback["rating"],
      atMs: number,
      errorMs: number,
      hold?: HitFeedback["hold"],
      star?: boolean,
    ) => {
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
        hold,
        star,
      });
      feedbackRef.current = pruned;
    },
    [],
  );

  const resetGameState = useCallback(() => {
    runtimeRef.current = createRuntimeState(chart);
    notesByIdRef.current = notesById(chart);
    sortedNotesRef.current = sortNotes(chart.notes);
    missCursorRef.current = 0;
    activeHoldsRef.current.clear();
    feedbackRef.current = [];
    laneFlashRef.current = emptyLaneFlash();
    phraseIndexRef.current = buildPhraseIndex(chart.notes);
    setScore(createInitialScore(chart.notes.length));
    commitStarPower(createStarPower());
    commitRockMeter(createRockMeter());
  }, [chart, commitStarPower, commitRockMeter]);

  // Run a short "3, 2, 1" countdown, then start the song from the top. This
  // gives the player a beat to get ready so the opening notes aren't missed the
  // instant they tap Start. Audio only begins once the count hits zero.
  const beginCountdown = useCallback(() => {
    clearCountdownTimer();
    // Unlock the audio clock NOW, while we're still inside the Start gesture's
    // call stack. The countdown's setInterval fires play() ~3s later — too late
    // to resume a suspended AudioContext — so without this the clock never
    // advances and the highway appears frozen.
    void audio.resume?.();
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
    } else if (current === "idle" || current === "finished" || current === "failed") {
      // Treat as a fresh start (with the same countdown).
      beginCountdown();
    }
  }, [audio, beginCountdown, clearCountdownTimer]);

  // Materialise the currently-held sustains as note objects. Small (usually 0–1
  // entries) so the per-frame / per-release hold checks stay O(active holds).
  const activeHoldNotes = useCallback((): ChartNote[] => {
    const set = activeHoldsRef.current;
    if (set.size === 0) return [];
    const out: ChartNote[] = [];
    for (const id of set) {
      const note = notesByIdRef.current.get(id);
      if (note) out.push(note);
    }
    return out;
  }, []);

  const pressLane = useCallback(
    (lane: Lane) => {
      if (phaseRef.current !== "playing") return;
      const t = audio.getTimeMs();
      laneFlashRef.current[lane] = t;

      // Only notes whose time sits within the good window of now can be hit, so
      // binary-search that slice instead of scanning the whole chart per tap.
      const notes = sortedNotesRef.current;
      const chartTimeMs = t - chart.offsetMs + calibrationRef.current;
      const [lo, hi] = noteIndexRange(
        notes,
        chartTimeMs - HIT_WINDOWS.good,
        chartTimeMs + HIT_WINDOWS.good,
      );

      const result = resolveTap(
        notes,
        runtimeRef.current,
        lane,
        t,
        chart.offsetMs,
        calibrationRef.current,
        lo,
        hi,
      );

      if (result.kind === "hit") {
        runtimeRef.current.set(result.note.id, {
          judged: true,
          rating: result.rating,
          judgedAtMs: t,
          // Begin tracking the sustain; taps stay undefined.
          hold: result.startsHold ? "holding" : undefined,
          holdStartMs: result.startsHold ? t : undefined,
        });
        if (result.startsHold) activeHoldsRef.current.add(result.note.id);
        const spMult = starPowerScoreMultiplier(starPowerRef.current);
        setScore((s) => applyHit(s, result.rating, spMult));
        commitRockMeter(rockMeterOnHit(rockMeterRef.current, result.rating));
        pushFeedback(lane, result.rating, t, result.errorMs);
        // Star phrase bookkeeping: completing one banks a quarter bar of meter
        // (extending the run if star power is already blazing).
        if (result.note.starPhrase !== undefined) {
          if (registerStarNoteHit(phraseIndexRef.current, result.note.starPhrase)) {
            commitStarPower(awardStarPhrase(starPowerRef.current, t));
            pushFeedback(lane, result.rating, t, 0, undefined, true);
          }
        }
      }
      // Stray taps (no note in window) are intentionally forgiving on a
      // touchscreen: they flash the lane but do not break combo.
    },
    [audio, chart.offsetMs, pushFeedback, activeHoldNotes, commitRockMeter, commitStarPower],
  );

  const releaseLane = useCallback(
    (lane: Lane) => {
      if (phaseRef.current !== "playing") return;
      const t = audio.getTimeMs();

      // Only sustains currently being held can be resolved by a release, so scan
      // just those instead of the whole chart.
      const result = resolveRelease(
        activeHoldNotes(),
        runtimeRef.current,
        lane,
        t,
        chart.offsetMs,
        calibrationRef.current,
      );

      if (result.kind === "completed") {
        const prev = runtimeRef.current.get(result.note.id);
        runtimeRef.current.set(result.note.id, {
          ...(prev ?? { judged: true }),
          hold: "completed",
          holdEndMs: t,
        });
        activeHoldsRef.current.delete(result.note.id);
        const spMult = starPowerScoreMultiplier(starPowerRef.current);
        setScore((s) => applyHoldComplete(s, result.note.durationMs ?? 0, spMult));
        pushFeedback(lane, "perfect", t, 0, "completed");
      } else if (result.kind === "dropped") {
        const prev = runtimeRef.current.get(result.note.id);
        runtimeRef.current.set(result.note.id, {
          ...(prev ?? { judged: true }),
          hold: "dropped",
          holdEndMs: t,
        });
        activeHoldsRef.current.delete(result.note.id);
        setScore((s) => applyHoldDrop(s));
        commitRockMeter(
          rockMeterOnDrop(rockMeterRef.current, starPowerRef.current.active),
        );
        playMissBuzz();
        pushFeedback(lane, "miss", t, 0, "dropped");
      }
      // No sustain in this lane → releasing is a harmless no-op.
    },
    [audio, chart.offsetMs, pushFeedback, activeHoldNotes, commitRockMeter],
  );

  const update = useCallback(
    (songTimeMs: number) => {
      if (phaseRef.current !== "playing") return;

      // Settle an active star-power run: once fully drained, switch it off.
      const ticked = tickStarPower(starPowerRef.current, songTimeMs);
      if (ticked !== starPowerRef.current) commitStarPower(ticked);

      // Miss detection walks a monotonic cursor from where it left off, so notes
      // already resolved earlier in the song are never re-scanned.
      const { missedIds, nextIndex } = collectMissedFrom(
        sortedNotesRef.current,
        runtimeRef.current,
        missCursorRef.current,
        songTimeMs,
        chart.offsetMs,
        calibrationRef.current,
      );
      missCursorRef.current = nextIndex;

      if (missedIds.length > 0) {
        let meter = rockMeterRef.current;
        const spActive = starPowerRef.current.active;
        for (const id of missedIds) {
          const note = notesByIdRef.current.get(id);
          runtimeRef.current.set(id, {
            judged: true,
            rating: "miss",
            judgedAtMs: songTimeMs,
          });
          meter = rockMeterOnMiss(meter, spActive);
          if (note) {
            pushFeedback(note.lane, "miss", songTimeMs, 0);
            // A missed star note kills its whole phrase's award.
            if (note.starPhrase !== undefined) {
              registerStarNoteMiss(phraseIndexRef.current, note.starPhrase);
            }
          }
        }
        setScore((s) =>
          missedIds.reduce((acc) => applyMiss(acc), s),
        );
        commitRockMeter(meter);
        playMissBuzz();

        // The crowd has had enough — booed off the stage, run over.
        if (isRockMeterFailed(meter)) {
          setPhase("failed");
          audio.stop();
          return;
        }
      }

      // Auto-complete sustains the player kept pressed through the tail's end,
      // so a held note resolves even without an explicit release event. Only the
      // handful of live sustains are checked, not every note in the chart.
      const completedHoldIds = findCompletedHoldIds(
        activeHoldNotes(),
        runtimeRef.current,
        songTimeMs,
        chart.offsetMs,
        calibrationRef.current,
      );

      if (completedHoldIds.length > 0) {
        let bonusDurations = 0;
        for (const id of completedHoldIds) {
          const note = notesByIdRef.current.get(id);
          const prev = runtimeRef.current.get(id);
          runtimeRef.current.set(id, {
            ...(prev ?? { judged: true }),
            hold: "completed",
            holdEndMs: songTimeMs,
          });
          activeHoldsRef.current.delete(id);
          if (note) {
            bonusDurations += note.durationMs ?? 0;
            pushFeedback(note.lane, "perfect", songTimeMs, 0, "completed");
          }
        }
        const spMult = starPowerScoreMultiplier(starPowerRef.current);
        setScore((s) => applyHoldComplete(s, bonusDurations, spMult));
      }

      // End the run once the song is over (covers trailing silence too).
      if (durationRef.current > 0 && songTimeMs >= durationRef.current + 250) {
        setPhase("finished");
        audio.stop();
      }
    },
    [audio, chart.offsetMs, pushFeedback, activeHoldNotes, commitRockMeter, commitStarPower],
  );

  // Finish as soon as every note has been judged — but not while a hold's tail
  // is still being held. A sustain's head counts as the note's single judgement,
  // so isComplete() can flip true the instant the last head is hit; ending then
  // would cut off the sustain (and its bonus) mid-hold. When the hold resolves,
  // the score changes and re-runs this effect (and update() auto-completes the
  // tail), so the finish just waits one beat for the last sustain to land.
  useEffect(() => {
    if (phase !== "playing" || !isComplete(score)) return;
    for (const state of runtimeRef.current.values()) {
      if (state.hold === "holding") return;
    }
    setPhase("finished");
    audio.stop();
  }, [phase, score, audio]);

  // Unleash banked star power. Guarded by the pure canActivate check inside
  // spActivate (returns the same state when not allowed → no write, no render).
  const activateStarPower = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    const next = spActivate(starPowerRef.current, audio.getTimeMs());
    if (next !== starPowerRef.current) commitStarPower(next);
  }, [audio, commitStarPower]);

  const adjustCalibration = useCallback((deltaMs: number) => {
    setCalibrationOffsetMs((prev) => prev + deltaMs);
  }, []);

  const resetCalibration = useCallback(
    () => setCalibrationOffsetMs(defaultCalibrationOffsetMs()),
    [],
  );

  return useMemo<RhythmGame>(
    () => ({
      phase,
      score,
      countdown,
      calibrationOffsetMs,
      starPower,
      rockMeter,
      runtimeRef,
      feedbackRef,
      laneFlashRef,
      starPowerRef,
      getCalibrationOffsetMs,
      activateStarPower,
      start,
      togglePause,
      restart,
      pressLane,
      releaseLane,
      tapLane: pressLane,
      update,
      adjustCalibration,
      resetCalibration,
    }),
    [
      phase,
      score,
      countdown,
      calibrationOffsetMs,
      starPower,
      rockMeter,
      getCalibrationOffsetMs,
      activateStarPower,
      start,
      togglePause,
      restart,
      pressLane,
      releaseLane,
      update,
      adjustCalibration,
      resetCalibration,
    ],
  );
}
