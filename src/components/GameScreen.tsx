"use client";

/**
 * GameScreen
 *
 * Composition root for an actual play session. It wires together:
 *   - useAudioEngine (the clock + sound),
 *   - useRhythmGame  (rules + transitions),
 *   - GameCanvas     (rendering + the rAF loop + tap-the-note input),
 *   - ScorePanel / CalibrationPanel (UI),
 *   - keyboard input for desktop testing.
 *
 * It deliberately holds almost no gameplay logic itself — that lives in the
 * pure modules and the two hooks. This file is orchestration + layout only.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { CalibrationPanel } from "./CalibrationPanel";
import { GameCanvas } from "./GameCanvas";
import { ScorePanel } from "./ScorePanel";
import styles from "./GameScreen.module.css";

import { KEYBOARD_LANE_MAP } from "@/game/constants";
import { chartDurationMs } from "@/game/chartUtils";
import { accuracyPercent, baseChartScore, isComplete, starRating } from "@/game/scoring";
import { ensureStarPhrases } from "@/game/starPower";
import type { RhythmChart } from "@/game/types";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useRhythmGame } from "@/hooks/useRhythmGame";
import { useYouTubeEngine } from "@/hooks/useYouTubeEngine";
import { recordSession } from "@/lib/metrics/client";
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

export function GameScreen({
  chart: rawChart,
  audioUrl,
  youtubeId,
  title,
  subtitle,
  sessionMeta,
}: GameScreenProps): React.JSX.Element {
  // Every chart gets star-power phrases: authored ones (Clone Hero imports)
  // pass through, everything else is auto-marked. Done once here so the game
  // hook and the renderer agree on which notes are stars.
  const chart = useMemo(() => ensureStarPhrases(rawChart), [rawChart]);
  // Denominator for the GH-style star rating (score ÷ base score).
  const baseScore = useMemo(() => baseChartScore(chart.notes), [chart]);

  // Both engines are instantiated (rules of hooks), but only the selected one is
  // ever driven. The Web Audio engine stays inert until loaded/played, and the
  // YouTube engine only creates a player when given a video id.
  const webAudio = useAudioEngine();
  const youtube = useYouTubeEngine(youtubeId);
  const audio = youtubeId ? youtube.engine : webAudio;

  const game = useRhythmGame(chart, audio);
  const { pressLane, releaseLane, togglePause, start, restart, activateStarPower } =
    game;
  const stars = starRating(game.score.score, baseScore);

  const [debug, setDebug] = useState({ song: 0, chart: 0 });

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
  // Enter or Shift unleashes star power. The primary input is tapping the notes
  // directly on the highway. Key-down presses (and begins a sustain); key-up
  // releases it, mirroring touch.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePause();
        return;
      }
      if (e.code === "Enter" || e.key === "Shift") {
        activateStarPower();
        return;
      }
      const lane = KEYBOARD_LANE_MAP[e.key.toLowerCase()];
      if (lane !== undefined) {
        pressLane(lane);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const lane = KEYBOARD_LANE_MAP[e.key.toLowerCase()];
      if (lane !== undefined) {
        releaseLane(lane);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pressLane, releaseLane, togglePause, activateStarPower]);

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
      const score = game.score;
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
  }, [game.phase, game.score, game.calibrationOffsetMs, chart, title, sessionMeta]);

  const showStart = game.phase === "idle";
  const showCountdown = game.phase === "countdown";
  const showPaused = game.phase === "paused";
  const showFinished = game.phase === "finished";
  const showFailed = game.phase === "failed";
  // In YouTube mode the player must be ready before we can start playback.
  const ytLoading = Boolean(youtubeId) && audio.status !== "ready";

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
          <button type="button" className={styles.pauseBtn} onClick={togglePause}>
            {game.phase === "playing" ? "Pause" : "Play"}
          </button>
        </div>
      </header>

      <div className={styles.stage}>
        {youtubeId && (
          <div
            ref={youtube.containerRef}
            className={styles.ytBackground}
            aria-label="YouTube audio source"
          />
        )}

        <div className={styles.canvasLayer}>
          <GameCanvas
            chart={chart}
            phase={game.phase}
            getTimeMs={audio.getTimeMs}
            getCalibrationOffsetMs={game.getCalibrationOffsetMs}
            runtimeRef={game.runtimeRef}
            feedbackRef={game.feedbackRef}
            laneFlashRef={game.laneFlashRef}
            starPowerRef={game.starPowerRef}
            onFrame={game.update}
            onLanePress={pressLane}
            onLaneRelease={releaseLane}
            onActivateStarPower={activateStarPower}
            combo={game.score.combo}
          />
        </div>

        <div className={`${styles.overlay} ${styles.overlayTopLeft}`}>
          <ScorePanel
            score={game.score}
            stars={stars}
            rockMeter={game.rockMeter}
            starPowerActive={game.starPower.active}
          />
        </div>

        <div className={`${styles.overlay} ${styles.overlayTopRight}`}>
          <CalibrationPanel
            calibrationOffsetMs={game.calibrationOffsetMs}
            onAdjust={game.adjustCalibration}
            onReset={game.resetCalibration}
            songTimeMs={debug.song}
            chartTimeMs={debug.chart}
          />
        </div>

        {showStart && (
          <Splash
            title={ytLoading ? "Loading video…" : "Ready?"}
            subtitle={
              ytLoading
                ? "Getting the YouTube player ready."
                : "Tap each note as it reaches the line — don't let the rock meter hit empty. Nail the ★ phrases, then tap the bottom meter to unleash Star Power for double points. (Desktop: A S D F G, Enter for Star Power.)"
            }
            actionLabel="Start"
            onAction={start}
            disabled={ytLoading}
          />
        )}

        {showCountdown && (
          <div className={styles.countdown} aria-live="assertive" role="status">
            <span key={game.countdown} className={styles.countdownNumber}>
              {game.countdown}
            </span>
            <span className={styles.countdownHint}>Get ready…</span>
          </div>
        )}

        {showPaused && (
          <Splash
            title="Paused"
            subtitle="Take a breath."
            actionLabel="Resume"
            onAction={togglePause}
            secondaryLabel="Restart"
            onSecondary={restart}
          />
        )}

        {showFailed && (
          <Splash
            title="Booed off stage!"
            subtitle="The rock meter hit empty — too many misses in a row. Shake it off and give the crowd another show."
            actionLabel="Try again"
            onAction={restart}
          />
        )}

        {showFinished && (
          <Results
            scoreText={game.score.score.toLocaleString()}
            stars={stars}
            maxCombo={game.score.maxCombo}
            accuracy={accuracyPercent(game.score)}
            perfect={game.score.perfect}
            great={game.score.great}
            good={game.score.good}
            miss={game.score.miss}
            starPhrases={game.starPower.phrasesCompleted}
            onReplay={restart}
          />
        )}
      </div>
    </div>
  );
}

function Splash({
  title,
  subtitle,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  disabled,
}: {
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.splash}>
      <div className={styles.splashCard}>
        <h2 className={styles.splashTitle}>{title}</h2>
        <p className={styles.splashSubtitle}>{subtitle}</p>
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
        </div>
      </div>
    </div>
  );
}

function Results({
  scoreText,
  stars,
  maxCombo,
  accuracy,
  perfect,
  great,
  good,
  miss,
  starPhrases,
  onReplay,
}: {
  scoreText: string;
  stars: number;
  maxCombo: number;
  accuracy: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  starPhrases: number;
  onReplay: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.splash}>
      <div className={styles.splashCard}>
        <h2 className={styles.splashTitle}>Song complete</h2>
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
