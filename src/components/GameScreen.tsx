"use client";

/**
 * GameScreen
 *
 * Composition root for an actual play session. It wires together:
 *   - useAudioEngine (the clock + sound),
 *   - useRhythmGame  (rules + transitions) — twice, for two-player mode, both
 *     on one clock through a shared transport,
 *   - GameCanvas     (rendering + the rAF loop + tap-the-note input),
 *   - FretPad        (tabletop posture: pads on the flat half),
 *   - ScorePanel / CalibrationPanel / TapTest (UI),
 *   - useFoldLayout  (foldable screens: highway on one side of the hinge),
 *   - useWakeLock    (screen stays on during a song),
 *   - keyboard input for desktop testing.
 *
 * It deliberately holds almost no gameplay logic itself — that lives in the
 * pure modules and the hooks. This file is orchestration + layout only.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CalibrationPanel } from "./CalibrationPanel";
import { FretPad } from "./FretPad";
import { GameCanvas } from "./GameCanvas";
import { ScorePanel } from "./ScorePanel";
import { TapTest } from "./TapTest";
import styles from "./GameScreen.module.css";

import { latencySeedMs } from "@/game/calibration";
import { KEYBOARD_LANE_MAP, KEYBOARD_LANE_MAP_P2, PRACTICE } from "@/game/constants";
import { chartDurationMs } from "@/game/chartUtils";
import { ensureHopos } from "@/game/hopo";
import { chartSections, type PracticeSection } from "@/game/practice";
import { accuracyPercent, baseChartScore, isComplete, starRating } from "@/game/scoring";
import { ensureStarPhrases } from "@/game/starPower";
import { defaultCalibrationOffsetMs } from "@/game/tuning";
import type { GamePhase, Lane, RhythmChart } from "@/game/types";
import { versusOutcome } from "@/game/versus";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useFoldLayout } from "@/hooks/useFoldLayout";
import { useRhythmGame, type RhythmGame } from "@/hooks/useRhythmGame";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useYouTubeEngine } from "@/hooks/useYouTubeEngine";
import {
  clearDeviceCalibration,
  loadDeviceCalibration,
  saveDeviceCalibration,
} from "@/lib/deviceCalibration";
import { canSeatTwoPlayers, screenFormChanged, stageLayout, type Rect } from "@/lib/foldable";
import {
  bestScore,
  chartScoreKey,
  submitScore,
  type LocalScoreEntry,
  type SubmitResult,
} from "@/lib/localScores";
import { recordSession } from "@/lib/metrics/client";
import { DEFAULT_PLAY_PREFS, loadPlayPrefs, savePlayPrefs, type PlayPrefs } from "@/lib/playPrefs";
import { createSharedTransport, createTransportState } from "@/lib/sharedTransport";
import type { SessionMeta } from "@/lib/activeSong";

interface GameScreenProps {
  chart: RhythmChart;
  /** blob: URL for uploaded audio. Omit for demo/silent mode. */
  audioUrl?: string;
  /** YouTube video id — when set, audio/timing come from the embedded player. */
  youtubeId?: string;
  title: string;
  /** Optional secondary line (artist · contributor). */
  subtitle?: string;
  /** Track identity used to attribute the anonymous session metric. */
  sessionMeta?: SessionMeta;
}

const LIVE_PHASES: ReadonlySet<GamePhase> = new Set(["countdown", "playing", "paused"]);
const isDone = (phase: GamePhase) => phase === "finished" || phase === "failed";

export function GameScreen({
  chart: rawChart,
  audioUrl,
  youtubeId,
  title,
  subtitle,
  sessionMeta,
}: GameScreenProps): React.JSX.Element {
  // Every chart gets star-power phrases and HOPO flags: authored ones (Clone
  // Hero imports, editor charts) pass through, everything else is auto-marked.
  // Done once here so the game hook and the renderer agree on which notes are
  // stars / hammer-ons.
  const chart = useMemo(() => ensureHopos(ensureStarPhrases(rawChart)), [rawChart]);
  // Denominator for the GH-style star rating (score ÷ base score).
  const baseScore = useMemo(() => baseChartScore(chart.notes), [chart]);

  // Both engines are instantiated (rules of hooks), but only the selected one is
  // ever driven. The Web Audio engine stays inert until loaded/played, and the
  // YouTube engine only creates a player when given a video id.
  const webAudio = useAudioEngine();
  const youtube = useYouTubeEngine(youtubeId);
  const audio = youtubeId ? youtube.engine : webAudio;

  // Two-player mode runs a second game on the same song. Both hooks always
  // exist (rules of hooks); player 2 stays inert in solo play. The shared
  // transport keeps one clock: it merges their play requests and only stops
  // the song once every active player is done.
  const [playerCount, setPlayerCount] = useState<1 | 2>(1);
  const playerCountRef = useRef<1 | 2>(1);
  playerCountRef.current = playerCount;
  const transportState = useRef(createTransportState());
  const [transport1, transport2] = useMemo(
    () => createSharedTransport(audio, () => playerCountRef.current, transportState.current),
    [audio],
  );

  const game = useRhythmGame(chart, transport1);
  const game2 = useRhythmGame(chart, transport2);
  const twoPlayer = playerCount === 2;
  const games: RhythmGame[] = twoPlayer ? [game, game2] : [game];

  const {
    pressLane,
    releaseLane,
    holdLane,
    unholdLane,
    whammyLane,
    restart,
    startPractice,
    exitPractice,
    activateStarPower,
    setCalibration,
  } = game;
  const stars = starRating(game.score.score, baseScore);
  const inPractice = game.practice !== null;

  // Session-level transport over every active player: pause/resume whoever is
  // mid-song, or start everyone fresh. Solo, this is exactly togglePause.
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const togglePauseAll = useCallback(() => {
    const all = gamesRef.current;
    const live = all.filter((g) => LIVE_PHASES.has(g.phase));
    if (live.length === 0) all.forEach((g) => g.start());
    else live.forEach((g) => g.togglePause());
  }, []);
  const restartAll = useCallback(() => gamesRef.current.forEach((g) => g.restart()), []);
  const anyPhase = (phase: GamePhase) => games.some((g) => g.phase === phase);
  const sessionPlaying = anyPhase("playing");

  // Practice mode: the chart's rehearsal sections + the player's picks.
  const sections = useMemo(() => chartSections(chart), [chart]);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [sectionPick, setSectionPick] = useState(0);
  const [speedPick, setSpeedPick] = useState<number>(1);

  // Local leaderboard identity: track + difficulty, stable across replays.
  const scoreKey = chartScoreKey(
    sessionMeta?.trackId ?? chart.id,
    sessionMeta?.difficulty ?? chart.difficulty,
  );
  const [best, setBest] = useState<LocalScoreEntry | null>(null);
  const [placing, setPlacing] = useState<SubmitResult | null>(null);
  useEffect(() => {
    setBest(bestScore(scoreKey));
    setPlacing(null);
  }, [scoreKey]);

  const [debug, setDebug] = useState({ song: 0, chart: 0 });

  // Keep the screen on from the count-in to the last note.
  useWakeLock(anyPhase("countdown") || sessionPlaying);

  // Calibration follows the device (its audio route), not the song: restore
  // the saved value, and persist every explicit change.
  const [tapTestOpen, setTapTestOpen] = useState(false);
  const [calibrationNote, setCalibrationNote] = useState<string | undefined>();
  useEffect(() => {
    const saved = loadDeviceCalibration();
    if (saved !== null) setCalibration(saved);
  }, [setCalibration]);
  const applyCalibration = (ms: number) => {
    setCalibration(ms);
    saveDeviceCalibration(ms);
    setCalibrationNote(undefined);
  };
  // Player 2 shares the device's audio route, so it shares the calibration.
  const setCalibration2 = game2.setCalibration;
  useEffect(() => {
    setCalibration2(game.calibrationOffsetMs);
  }, [game.calibrationOffsetMs, setCalibration2]);

  // No saved calibration yet? Seed one from the browser's reported output
  // latency (Chrome/Firefox expose it; Safari doesn't) once the clock is
  // running — during the countdown, before any note is due. Not saved: it's a
  // guess until the player confirms it with the buttons or the tap test.
  const latencySeededRef = useRef(false);
  const getOutputLatencySec = webAudio.getOutputLatencySec;
  useEffect(() => {
    if (youtubeId || latencySeededRef.current || game.phase !== "countdown") return;
    if (loadDeviceCalibration() !== null) {
      latencySeededRef.current = true;
      return;
    }
    const latency = getOutputLatencySec();
    if (latency === null) return; // not reported yet — retry on the next tick
    latencySeededRef.current = true;
    const seed = latencySeedMs(latency, defaultCalibrationOffsetMs());
    if (seed === null) return;
    setCalibration(seed);
    setCalibrationNote(
      `Slow audio output detected (~${Math.round(latency * 1000)} ms, likely Bluetooth) — calibration adjusted. Run the tap test to fine-tune.`,
    );
  }, [youtubeId, game.phase, game.countdown, getOutputLatencySec, setCalibration]);

  // Per-device layout choices: which side of the hinge the highway takes, and
  // fret pads in tabletop posture. Loaded after mount (storage is client-only).
  const [prefs, setPrefs] = useState<PlayPrefs>(DEFAULT_PLAY_PREFS);
  useEffect(() => setPrefs(loadPlayPrefs()), []);
  const updatePrefs = (patch: Partial<PlayPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePlayPrefs(next);
  };

  // Foldables (iPhone Duo): when the screen is half-folded, keep the highway on
  // one side of the hinge and move the HUD to the other.
  const stageRef = useRef<HTMLDivElement>(null);
  const fold = useFoldLayout(stageRef, prefs.highwaySide);
  const twoPlayerFits = canSeatTwoPlayers(fold.split, fold.stage);
  const layout = stageLayout(fold.split, fold.stage, {
    fretPad: prefs.fretPad,
    players: playerCount,
  });
  // Back to solo when the screen can no longer seat two (e.g. folded shut),
  // but never mid-song — that run is paused below and finishes as it started.
  const anyLive = LIVE_PHASES.has(game.phase) || LIVE_PHASES.has(game2.phase);
  useEffect(() => {
    if (twoPlayer && !twoPlayerFits && !anyLive) setPlayerCount(1);
  }, [twoPlayer, twoPlayerFits, anyLive]);

  // Folding, unfolding, or rotating mid-song moves every lane out from under
  // the player's fingers — pause, like a game does when a controller drops.
  const [pausedForScreen, setPausedForScreen] = useState(false);
  const formRef = useRef(fold.form);
  useEffect(() => {
    const prev = formRef.current;
    formRef.current = fold.form;
    if (!sessionPlaying) return;
    if (screenFormChanged(prev, fold.form)) {
      togglePauseAll();
      setPausedForScreen(true);
    } else {
      setPausedForScreen(false); // resumed (or started) on a settled screen
    }
  }, [fold.form, sessionPlaying, togglePauseAll]);

  const tailMs = 2000;
  const durationMs = useMemo(() => chartDurationMs(chart) + tailMs, [chart]);

  // Load audio (or silent demo timeline) when the song changes. In YouTube mode
  // the engine self-loads from the video id, so skip this entirely.
  const loadFromUrl = audio.loadFromUrl;
  const loadSilent = audio.loadSilent;
  useEffect(() => {
    if (youtubeId) return;
    let cancelled = false;
    if (audioUrl) {
      loadFromUrl(audioUrl).catch(() => {
        if (!cancelled) loadSilent(durationMs);
      });
    } else {
      loadSilent(durationMs);
    }
    return () => {
      cancelled = true;
    };
  }, [youtubeId, audioUrl, durationMs, loadFromUrl, loadSilent]);

  // Keyboard input (desktop testing only): A/S/D/F/G lanes, Space play/pause,
  // Enter or Shift unleashes star power. Two players: P2 gets H/J/K/L/; with
  // Enter/right Shift, P1 keeps left Shift. The primary input is tapping the
  // notes directly on the highway. Key-down presses (and begins a sustain);
  // key-up releases it, mirroring touch. A held key counts as a positional hold
  // (so HOPOs auto-hit), and its auto-repeat acts as the whammy.
  // Read through a ref so the listeners aren't re-bound on every hit.
  const playersRef = useRef([game, game2] as const);
  playersRef.current = [game, game2];
  useEffect(() => {
    if (tapTestOpen) return; // the tap test owns the keyboard while open
    const route = (e: KeyboardEvent): [RhythmGame, Lane] | null => {
      const [p1Game, p2Game] = playersRef.current;
      const key = e.key.toLowerCase();
      const p1 = KEYBOARD_LANE_MAP[key];
      if (p1 !== undefined) return [p1Game, p1];
      const p2 = twoPlayer ? KEYBOARD_LANE_MAP_P2[key] : undefined;
      return p2 !== undefined ? [p2Game, p2] : null;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const hit = route(e);
      if (e.repeat) {
        if (hit) hit[0].whammyLane(hit[1]);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePauseAll();
        return;
      }
      if (e.code === "Enter" || e.key === "Shift") {
        const p2Star = twoPlayer && (e.code === "Enter" || e.code === "ShiftRight");
        playersRef.current[p2Star ? 1 : 0].activateStarPower();
        return;
      }
      if (hit) {
        hit[0].pressLane(hit[1]);
        hit[0].holdLane(hit[1]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const hit = route(e);
      if (hit) {
        hit[0].unholdLane(hit[1]);
        hit[0].releaseLane(hit[1]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [tapTestOpen, twoPlayer, togglePauseAll]);

  // Low-frequency debug clock (10 fps) so the calibration readout updates
  // without coupling to the animation loop.
  const getTimeMs = audio.getTimeMs;
  const calibrationOffsetMs = game.calibrationOffsetMs;
  useEffect(() => {
    if (game.phase !== "playing") return;
    const id = window.setInterval(() => {
      const t = getTimeMs();
      setDebug({ song: t, chart: t - chart.offsetMs + calibrationOffsetMs });
    }, 100);
    return () => window.clearInterval(id);
  }, [game.phase, getTimeMs, calibrationOffsetMs, chart.offsetMs]);

  // Record one anonymous metric per finished (or failed) run. The flag resets
  // when a new run starts (countdown/playing) so replays are counted, but a
  // single finish — which two code paths in the engine can trigger — is
  // recorded only once. Failed runs record too (completed: false) so the
  // self-improvement loop sees charts that boo players off the stage.
  const recordedRef = useRef(false);
  useEffect(() => {
    if (game.phase === "finished" || game.phase === "failed") {
      if (recordedRef.current) return;
      recordedRef.current = true;
      // Practice loops are rehearsal and versus runs are a party game —
      // neither is recorded or ranked.
      if (game.practice || twoPlayer) return;
      const score = game.score;
      // Completed runs go on the device's leaderboard for this chart.
      if (game.phase === "finished") {
        const result = submitScore(scoreKey, {
          score: score.score,
          stars: starRating(score.score, baseScore),
          accuracy: accuracyPercent(score),
          maxCombo: score.maxCombo,
          completed: isComplete(score),
          at: new Date().toISOString(),
        });
        setPlacing(result);
        setBest(result.board[0] ?? null);
      }
      recordSession({
        chartId: sessionMeta?.trackId ?? chart.id,
        title,
        artist: sessionMeta?.artist ?? chart.artist,
        difficulty: sessionMeta?.difficulty ?? chart.difficulty,
        source: sessionMeta?.source ?? "unknown",
        bpm: sessionMeta?.bpm ?? chart.bpm,
        totalNotes: score.totalNotes,
        score: score.score,
        maxCombo: score.maxCombo,
        accuracy: accuracyPercent(score),
        perfect: score.perfect,
        great: score.great,
        good: score.good,
        miss: score.miss,
        calibrationOffsetMs: game.calibrationOffsetMs,
        completed: isComplete(score),
        durationMs: chartDurationMs(chart),
      });
    } else if (game.phase === "countdown" || game.phase === "playing") {
      recordedRef.current = false;
    }
  }, [
    game.phase,
    game.score,
    game.practice,
    game.calibrationOffsetMs,
    twoPlayer,
    chart,
    title,
    sessionMeta,
    scoreKey,
    baseScore,
  ]);

  const showStart = games.every((g) => g.phase === "idle");
  const showCountdown = anyPhase("countdown");
  const showPaused = anyPhase("paused");
  const showFinished = !twoPlayer && game.phase === "finished";
  const showFailed = !twoPlayer && game.phase === "failed";
  // In YouTube mode the player must be ready before we can start playback.
  const ytLoading = Boolean(youtubeId) && audio.status !== "ready";
  // Modals sit over the highway pane, never across the hinge.
  const modalStyle = paneStyle(layout.modal);
  const countdownValue = Math.max(...games.map((g) => g.countdown));

  const scorePanel = (
    <ScorePanel
      score={game.score}
      stars={stars}
      rockMeter={game.rockMeter}
      starPowerActive={game.starPower.active}
      practiceLabel={
        game.practice
          ? `${game.practice.label}${speedPick !== 1 ? ` · ${speedPick}×` : ""}`
          : undefined
      }
    />
  );
  const calibrationPanel = (
    <CalibrationPanel
      calibrationOffsetMs={game.calibrationOffsetMs}
      onAdjust={(delta) => applyCalibration(game.calibrationOffsetMs + delta)}
      onReset={() => {
        game.resetCalibration();
        clearDeviceCalibration();
        setCalibrationNote(undefined);
      }}
      onTapTest={() => setTapTestOpen(true)}
      tapTestDisabled={game.phase === "playing" || game.phase === "countdown"}
      note={calibrationNote}
      songTimeMs={debug.song}
      chartTimeMs={debug.chart}
    />
  );
  // The calibration panel sits under the ready/pause cards, so the cards carry
  // their own way into the tap test.
  const tapTestLink = (
    <button type="button" className={styles.linkBtn} onClick={() => setTapTestOpen(true)}>
      Notes feel late (Bluetooth)? Run the tap test
    </button>
  );
  // Fold-specific layout switches, shown in the HUD pane.
  const layoutControls =
    fold.split.kind === "book" ? (
      <button
        type="button"
        className={styles.layoutBtn}
        onClick={() =>
          updatePrefs({ highwaySide: prefs.highwaySide === "end" ? "start" : "end" })
        }
      >
        ⇄ Swap sides
      </button>
    ) : fold.split.kind === "tabletop" && !prefs.fretPad ? (
      <button
        type="button"
        className={styles.layoutBtn}
        onClick={() => updatePrefs({ fretPad: true })}
      >
        Use fret pads
      </button>
    ) : null;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href="/" className={styles.back} aria-label="Back to home">
            ‹ Home
          </Link>
          <span className={styles.titleGroup}>
            <span className={styles.songTitle}>{title}</span>
            {subtitle && <span className={styles.songSubtitle}>{subtitle}</span>}
          </span>
        </div>
        <div className={styles.headerRight}>
          <button type="button" className={styles.pauseBtn} onClick={togglePauseAll}>
            {sessionPlaying ? "Pause" : "Play"}
          </button>
        </div>
      </header>

      <div ref={stageRef} className={styles.stage}>
        {youtubeId && (
          <div
            ref={youtube.containerRef}
            className={styles.ytBackground}
            aria-label="YouTube audio source"
          />
        )}

        {games.map((g, i) => (
          <div key={i} className={styles.canvasLayer} style={paneStyle(layout.highways[i])}>
            <GameCanvas
              chart={chart}
              phase={g.phase}
              getTimeMs={audio.getTimeMs}
              getCalibrationOffsetMs={g.getCalibrationOffsetMs}
              runtimeRef={g.runtimeRef}
              feedbackRef={g.feedbackRef}
              laneFlashRef={g.laneFlashRef}
              starPowerRef={g.starPowerRef}
              onFrame={g.update}
              onLanePress={g.pressLane}
              onLaneRelease={g.releaseLane}
              onLaneHold={g.holdLane}
              onLaneUnhold={g.unholdLane}
              onWhammy={g.whammyLane}
              onActivateStarPower={g.activateStarPower}
              combo={g.score.combo}
            />
          </div>
        ))}

        {layout.pads && (
          <FretPad
            style={paneStyle(layout.pads)}
            onLanePress={pressLane}
            onLaneRelease={releaseLane}
            onLaneHold={holdLane}
            onLaneUnhold={unholdLane}
            onWhammy={whammyLane}
            onActivateStarPower={activateStarPower}
            onExit={() => updatePrefs({ fretPad: false })}
          />
        )}

        {twoPlayer ? (
          games.map((g, i) => {
            const pane = layout.highways[i];
            return (
              <div
                key={i}
                className={`${styles.overlay} ${styles.playerHud}`}
                style={{ left: (pane?.x ?? 0) + 12, top: (pane?.y ?? 0) + 12 }}
              >
                <span className={styles.playerTag}>P{i + 1}</span>
                <ScorePanel
                  compact
                  score={g.score}
                  stars={starRating(g.score.score, baseScore)}
                  rockMeter={g.rockMeter}
                  starPowerActive={g.starPower.active}
                />
              </div>
            );
          })
        ) : layout.hud ? (
          <div className={styles.hudPane} style={paneStyle(layout.hud)}>
            {scorePanel}
            {calibrationPanel}
            {layoutControls}
          </div>
        ) : (
          <div className={styles.overlayLayer} style={paneStyle(layout.highways[0])}>
            <div className={`${styles.overlay} ${styles.overlayTopLeft}`}>{scorePanel}</div>
            <div className={`${styles.overlay} ${styles.overlayTopRight}`}>
              {calibrationPanel}
            </div>
          </div>
        )}

        {showStart && practiceOpen && (
          <PracticePicker
            style={modalStyle}
            sections={sections}
            sectionPick={sectionPick}
            onPickSection={setSectionPick}
            speedPick={speedPick}
            onPickSpeed={setSpeedPick}
            onStart={() => {
              const section = sections[Math.min(sectionPick, sections.length - 1)];
              if (section) {
                setPracticeOpen(false);
                startPractice(section, speedPick);
              }
            }}
            onBack={() => setPracticeOpen(false)}
          />
        )}

        {showStart && !practiceOpen && !twoPlayer && (
          <Splash
            style={modalStyle}
            title={ytLoading ? "Loading video…" : "Ready?"}
            subtitle={
              ytLoading
                ? "Getting the YouTube player ready."
                : layout.pads
                  ? "Fret-pad mode: watch the highway up top and press the matching pad below as each note reaches the line. Slide between pads for hammer-ons, wiggle a held pad on ★ sustains, and hit the ★ strip to unleash Star Power."
                  : "Tap each note as it reaches the line — don't let the rock meter hit empty. Ring-marked notes are hammer-ons: rest or slide a finger on their lane and they play themselves. Nail the ★ phrases (wiggle held ★ sustains for extra juice), then tap the bottom meter to unleash Star Power for double points. (Desktop: A S D F G, Enter for Star Power.)"
            }
            actionLabel="Start"
            onAction={togglePauseAll}
            secondaryLabel={sections.length > 0 ? "Practice" : undefined}
            onSecondary={sections.length > 0 ? () => setPracticeOpen(true) : undefined}
            tertiaryLabel={twoPlayerFits ? "2 players" : undefined}
            onTertiary={twoPlayerFits ? () => setPlayerCount(2) : undefined}
            disabled={ytLoading}
            extra={
              <>
                {best && (
                  <p className={styles.bestLine}>
                    Best on this device:{" "}
                    <strong>{best.score.toLocaleString()}</strong>
                    {" · "}
                    {"★".repeat(best.stars)}
                    {"☆".repeat(5 - best.stars)}
                  </p>
                )}
                {!ytLoading && tapTestLink}
              </>
            }
          />
        )}

        {showStart && twoPlayer && (
          <Splash
            style={modalStyle}
            title={ytLoading ? "Loading video…" : "Two players"}
            subtitle={
              ytLoading
                ? "Getting the YouTube player ready."
                : "One song, two highways: P1 plays the left, P2 the right. Highest score wins — get booed off and you forfeit. Each player taps their own highway and ★ meter. (Keyboard: P1 A S D F G + left Shift, P2 H J K L ; + Enter.)"
            }
            actionLabel="Start"
            onAction={togglePauseAll}
            secondaryLabel="1 player"
            onSecondary={() => setPlayerCount(1)}
            disabled={ytLoading}
          />
        )}

        {showCountdown && (
          <div
            className={styles.countdown}
            style={modalStyle}
            aria-live="assertive"
            role="status"
          >
            <span key={countdownValue} className={styles.countdownNumber}>
              {countdownValue}
            </span>
            <span className={styles.countdownHint}>Get ready…</span>
          </div>
        )}

        {showPaused && (
          <Splash
            style={modalStyle}
            title={inPractice ? "Practice paused" : "Paused"}
            subtitle={
              pausedForScreen
                ? "Your screen changed shape, so the highway moved — resume when your fingers are back on the lanes."
                : inPractice
                  ? `Looping ${game.practice?.label ?? "section"} — no fail, no pressure.`
                  : "Take a breath."
            }
            actionLabel="Resume"
            onAction={togglePauseAll}
            secondaryLabel={inPractice ? "Restart loop" : "Restart"}
            onSecondary={twoPlayer ? restartAll : restart}
            tertiaryLabel={inPractice ? "Exit practice" : undefined}
            onTertiary={inPractice ? exitPractice : undefined}
            extra={twoPlayer ? undefined : tapTestLink}
          />
        )}

        {showFailed && (
          <Splash
            style={modalStyle}
            title="Booed off stage!"
            subtitle="The rock meter hit empty — too many misses in a row. Shake it off and give the crowd another show."
            actionLabel="Try again"
            onAction={restart}
          />
        )}

        {showFinished && (
          <Results
            style={modalStyle}
            scoreText={game.score.score.toLocaleString()}
            stars={stars}
            maxCombo={game.score.maxCombo}
            accuracy={accuracyPercent(game.score)}
            perfect={game.score.perfect}
            great={game.score.great}
            good={game.score.good}
            miss={game.score.miss}
            starPhrases={game.starPower.phrasesCompleted}
            placing={placing}
            onReplay={restart}
          />
        )}

        {twoPlayer &&
          games.map((g, i) => {
            if (!isDone(g.phase)) return null;
            const other = games[1 - i];
            const bothDone = other ? isDone(other.phase) : true;
            const outcome = bothDone
              ? versusOutcome(
                  { score: game.score.score, failed: game.phase === "failed" },
                  { score: game2.score.score, failed: game2.phase === "failed" },
                )
              : null;
            return (
              <VersusCard
                key={i}
                style={paneStyle(layout.highways[i])}
                player={i + 1}
                failed={g.phase === "failed"}
                score={g.score.score}
                accuracy={accuracyPercent(g.score)}
                maxCombo={g.score.maxCombo}
                stars={starRating(g.score.score, baseScore)}
                result={
                  outcome === null
                    ? null
                    : outcome === "draw"
                      ? "draw"
                      : outcome === `p${i + 1}`
                        ? "win"
                        : "lose"
                }
                onReplay={restartAll}
                onSolo={() => {
                  game.reset();
                  game2.reset();
                  setPlayerCount(1);
                }}
              />
            );
          })}

        {tapTestOpen && (
          <TapTest
            style={modalStyle}
            classes={{
              overlay: `${styles.splash} ${styles.splashTop}`,
              card: styles.splashCard,
              title: styles.splashTitle,
              subtitle: styles.splashSubtitle,
              actions: styles.splashActions,
              primary: styles.primaryBtn,
              secondary: styles.secondaryBtn,
            }}
            onApply={(ms) => {
              applyCalibration(ms);
              setTapTestOpen(false);
            }}
            onClose={() => setTapTestOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One player's card in two-player mode, over their own highway: "waiting"
 * while the other player is still going, then win/lose/draw once both are done.
 */
function VersusCard({
  style,
  player,
  failed,
  score,
  accuracy,
  maxCombo,
  stars,
  result,
  onReplay,
  onSolo,
}: {
  style?: React.CSSProperties;
  player: number;
  failed: boolean;
  score: number;
  accuracy: number;
  maxCombo: number;
  stars: number;
  /** null while the other player is still mid-song. */
  result: "win" | "lose" | "draw" | null;
  onReplay: () => void;
  onSolo: () => void;
}): React.JSX.Element {
  const heading =
    result === "win"
      ? `P${player} wins!`
      : result === "draw"
        ? "Draw!"
        : result === "lose"
          ? failed
            ? `P${player} booed off`
            : `P${player} loses`
          : failed
            ? `P${player} booed off!`
            : `P${player} finished!`;
  return (
    <div className={styles.splash} style={style}>
      <div className={styles.splashCard}>
        <h2 className={`${styles.splashTitle} ${result === "win" ? styles.versusWin : ""}`}>
          {heading}
        </h2>
        <div className={styles.resultScore}>{score.toLocaleString()}</div>
        <div className={styles.resultStars} role="img" aria-label={`${stars} of 5 stars`}>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < stars ? styles.starEarned : styles.starEmpty}>
              ★
            </span>
          ))}
        </div>
        <p className={styles.splashSubtitle}>
          {accuracy.toFixed(1)}% accuracy · max combo {maxCombo}
        </p>
        {result === null ? (
          <p className={styles.splashSubtitle}>Waiting for the other player…</p>
        ) : (
          <div className={styles.splashActions}>
            <button type="button" className={styles.primaryBtn} onClick={onReplay}>
              Rematch
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={onSolo}>
              1 player
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Absolute-position an overlay over one pane of a split stage. */
function paneStyle(rect: Rect | undefined): React.CSSProperties | undefined {
  if (!rect) return undefined;
  return {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    right: "auto",
    bottom: "auto",
  };
}

function Splash({
  style,
  title,
  subtitle,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  tertiaryLabel,
  onTertiary,
  disabled,
  extra,
}: {
  style?: React.CSSProperties;
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  tertiaryLabel?: string;
  onTertiary?: () => void;
  disabled?: boolean;
  extra?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.splash} style={style}>
      <div className={styles.splashCard}>
        <h2 className={styles.splashTitle}>{title}</h2>
        <p className={styles.splashSubtitle}>{subtitle}</p>
        {extra}
        <div className={styles.splashActions}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={onAction}
            disabled={disabled}
          >
            {actionLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button type="button" className={styles.secondaryBtn} onClick={onSecondary}>
              {secondaryLabel}
            </button>
          )}
          {tertiaryLabel && onTertiary && (
            <button type="button" className={styles.secondaryBtn} onClick={onTertiary}>
              {tertiaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Practice setup card: pick one of the chart's sections and a playback speed,
 * then loop it. Sections are 8 bars (or ~15s without a tempo); empty ones are
 * already filtered out.
 */
function PracticePicker({
  style,
  sections,
  sectionPick,
  onPickSection,
  speedPick,
  onPickSpeed,
  onStart,
  onBack,
}: {
  style?: React.CSSProperties;
  sections: PracticeSection[];
  sectionPick: number;
  onPickSection: (index: number) => void;
  speedPick: number;
  onPickSpeed: (speed: number) => void;
  onStart: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.splash} style={style}>
      <div className={styles.splashCard}>
        <h2 className={styles.splashTitle}>Practice mode</h2>
        <p className={styles.splashSubtitle}>
          Loop one section until it sticks — the crowd can&apos;t boo you off, and
          you can slow the song down while you learn it.
        </p>
        <div className={styles.practiceSections} role="group" aria-label="Section">
          {sections.map((s, i) => (
            <button
              key={s.index}
              type="button"
              className={`${styles.practiceChip} ${i === sectionPick ? styles.practiceChipActive : ""}`}
              onClick={() => onPickSection(i)}
            >
              <span>{s.label}</span>
              <em>{s.noteCount} notes</em>
            </button>
          ))}
        </div>
        <div className={styles.practiceSpeeds} role="group" aria-label="Speed">
          {PRACTICE.speeds.map((speed) => (
            <button
              key={speed}
              type="button"
              className={`${styles.practiceChip} ${speed === speedPick ? styles.practiceChipActive : ""}`}
              onClick={() => onPickSpeed(speed)}
            >
              {speed === 1 ? "Full speed" : `${speed}×`}
            </button>
          ))}
        </div>
        <div className={styles.splashActions}>
          <button type="button" className={styles.primaryBtn} onClick={onStart}>
            Start practicing
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

function Results({
  style,
  scoreText,
  stars,
  maxCombo,
  accuracy,
  perfect,
  great,
  good,
  miss,
  starPhrases,
  placing,
  onReplay,
}: {
  style?: React.CSSProperties;
  scoreText: string;
  stars: number;
  maxCombo: number;
  accuracy: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  starPhrases: number;
  placing: SubmitResult | null;
  onReplay: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.splash} style={style}>
      <div className={styles.splashCard}>
        <h2 className={styles.splashTitle}>Song complete</h2>
        {placing?.isNewBest && (
          <p className={styles.newBest} role="status">
            ★ NEW BEST ON THIS DEVICE ★
            {placing.previousBest !== null && (
              <em> previous: {placing.previousBest.toLocaleString()}</em>
            )}
          </p>
        )}
        <div
          className={styles.resultStars}
          role="img"
          aria-label={`${stars} of 5 stars`}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < stars ? styles.starEarned : styles.starEmpty}>
              ★
            </span>
          ))}
        </div>
        <div className={styles.resultScore}>{scoreText}</div>
        <div className={styles.resultGrid}>
          <span>Accuracy</span>
          <strong>{accuracy.toFixed(1)}%</strong>
          <span>Max combo</span>
          <strong>{maxCombo}</strong>
          <span>Star phrases</span>
          <strong>{starPhrases}</strong>
          <span>Perfect</span>
          <strong>{perfect}</strong>
          <span>Great</span>
          <strong>{great}</strong>
          <span>Good</span>
          <strong>{good}</strong>
          <span>Miss</span>
          <strong>{miss}</strong>
        </div>
        {placing && placing.board.length > 0 && (
          <div className={styles.board}>
            <span className={styles.boardTitle}>Top scores on this device</span>
            <ol className={styles.boardList}>
              {placing.board.map((entry, i) => (
                <li
                  key={`${entry.at}-${entry.score}`}
                  className={placing.rank === i + 1 ? styles.boardRowMine : undefined}
                >
                  <span>{entry.score.toLocaleString()}</span>
                  <em>
                    {"★".repeat(entry.stars)} · {entry.accuracy.toFixed(0)}%
                  </em>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className={styles.splashActions}>
          <button type="button" className={styles.primaryBtn} onClick={onReplay}>
            Play again
          </button>
          <Link href="/dashboard" className={styles.secondaryBtn}>
            Your stats
          </Link>
          <Link href="/" className={styles.secondaryBtn}>
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
