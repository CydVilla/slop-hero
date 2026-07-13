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

import { KEYBOARD_LANE_MAP, PRACTICE } from "@/game/constants";
import { chartDurationMs } from "@/game/chartUtils";
import { ensureHopos } from "@/game/hopo";
import { chartSections, type PracticeSection } from "@/game/practice";
import { accuracyPercent, baseChartScore, isComplete, starRating } from "@/game/scoring";
import { ensureStarPhrases } from "@/game/starPower";
import type { RhythmChart } from "@/game/types";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useRhythmGame } from "@/hooks/useRhythmGame";
import { useYouTubeEngine } from "@/hooks/useYouTubeEngine";
import {
  bestScore,
  chartScoreKey,
  submitScore,
  type LocalScoreEntry,
  type SubmitResult,
} from "@/lib/localScores";
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

  const game = useRhythmGame(chart, audio);
  const {
    pressLane,
    releaseLane,
    holdLane,
    unholdLane,
    whammyLane,
    togglePause,
    start,
    restart,
    startPractice,
    exitPractice,
    activateStarPower,
  } = game;
  const stars = starRating(game.score.score, baseScore);
  const inPractice = game.practice !== null;

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
  // releases it, mirroring touch. A held key counts as a positional hold (so
  // HOPOs auto-hit), and its auto-repeat acts as the whammy on star sustains.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) {
        const lane = KEYBOARD_LANE_MAP[e.key.toLowerCase()];
        if (lane !== undefined) whammyLane(lane);
        return;
      }
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
        holdLane(lane);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const lane = KEYBOARD_LANE_MAP[e.key.toLowerCase()];
      if (lane !== undefined) {
        unholdLane(lane);
        releaseLane(lane);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pressLane, releaseLane, holdLane, unholdLane, whammyLane, togglePause, activateStarPower]);

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
      // Practice loops are rehearsal — never recorded, never ranked.
      if (game.practice) return;
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
    chart,
    title,
    sessionMeta,
    scoreKey,
    baseScore,
  ]);

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
            onLaneHold={holdLane}
            onLaneUnhold={unholdLane}
            onWhammy={whammyLane}
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
            practiceLabel={
              game.practice
                ? `${game.practice.label}${speedPick !== 1 ? ` · ${speedPick}×` : ""}`
                : undefined
            }
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

        {showStart && practiceOpen && (
          <PracticePicker
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

        {showStart && !practiceOpen && (
          <Splash
            title={ytLoading ? "Loading video…" : "Ready?"}
            subtitle={
              ytLoading
                ? "Getting the YouTube player ready."
                : "Tap each note as it reaches the line — don't let the rock meter hit empty. Ring-marked notes are hammer-ons: rest or slide a finger on their lane and they play themselves. Nail the ★ phrases (wiggle held ★ sustains for extra juice), then tap the bottom meter to unleash Star Power for double points. (Desktop: A S D F G, Enter for Star Power.)"
            }
            actionLabel="Start"
            onAction={start}
            secondaryLabel={sections.length > 0 ? "Practice" : undefined}
            onSecondary={sections.length > 0 ? () => setPracticeOpen(true) : undefined}
            disabled={ytLoading}
            extra={
              best ? (
                <p className={styles.bestLine}>
                  Best on this device:{" "}
                  <strong>{best.score.toLocaleString()}</strong>
                  {" · "}
                  {"★".repeat(best.stars)}
                  {"☆".repeat(5 - best.stars)}
                </p>
              ) : undefined
            }
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
            title={inPractice ? "Practice paused" : "Paused"}
            subtitle={
              inPractice
                ? `Looping ${game.practice?.label ?? "section"} — no fail, no pressure.`
                : "Take a breath."
            }
            actionLabel="Resume"
            onAction={togglePause}
            secondaryLabel={inPractice ? "Restart loop" : "Restart"}
            onSecondary={restart}
            tertiaryLabel={inPractice ? "Exit practice" : undefined}
            onTertiary={inPractice ? exitPractice : undefined}
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
            placing={placing}
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
  tertiaryLabel,
  onTertiary,
  disabled,
  extra,
}: {
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
    <div className={styles.splash}>
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
  sections,
  sectionPick,
  onPickSection,
  speedPick,
  onPickSpeed,
  onStart,
  onBack,
}: {
  sections: PracticeSection[];
  sectionPick: number;
  onPickSection: (index: number) => void;
  speedPick: number;
  onPickSpeed: (speed: number) => void;
  onStart: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.splash}>
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
    <div className={styles.splash}>
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
