"use client";

/**
 * TapTest
 *
 * Tap-along latency calibration. Plays a metronome through Web Audio (the same
 * clock and output route the game uses), the player taps a big pad on every
 * click, and the median lag between click and tap becomes the calibration.
 * That catches what the ±10 ms buttons can't reasonably cover: Bluetooth
 * headphones that deliver the song 150–250 ms late.
 *
 * Deliberately audio-only — no flashing beat indicator — so players sync to
 * what they HEAR. A visual cue would measure their eyes instead of the audio
 * route, which is exactly the lag this test exists to find.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./TapTest.module.css";

import { TAP_TEST, calibrationFromTapErrors, median, tapErrorsMs } from "@/game/calibration";
import { setAudioSessionType } from "@/lib/audioSession";

interface TapTestProps {
  style?: React.CSSProperties;
  /** Overlay + card + button classes from the host screen, for a consistent look. */
  classes: Record<
    "overlay" | "card" | "title" | "subtitle" | "actions" | "primary" | "secondary",
    string | undefined
  >;
  onApply: (calibrationMs: number) => void;
  onClose: () => void;
}

type Stage =
  | { kind: "intro" }
  | { kind: "running"; scored: number }
  | { kind: "result"; calibrationMs: number; lagMs: number }
  | { kind: "failed" };

const TOTAL_CLICKS = TAP_TEST.leadInClicks + TAP_TEST.measuredClicks;
const BEAT_SEC = 60 / TAP_TEST.bpm;
const START_DELAY_SEC = 0.6;

function scheduleClick(ctx: AudioContext, at: number, accent: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = accent ? 1760 : 1320;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.5, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.06);
}

export function TapTest({ style, classes, onApply, onClose }: TapTestProps): React.JSX.Element {
  const [stage, setStage] = useState<Stage>({ kind: "intro" });
  const ctxRef = useRef<AudioContext | null>(null);
  const clicksRef = useRef<number[]>([]);
  const tapsRef = useRef<number[]>([]);
  const timerRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const finish = useCallback(() => {
    const errors = tapErrorsMs(tapsRef.current, clicksRef.current);
    const calibrationMs = calibrationFromTapErrors(errors);
    teardown();
    setStage(
      calibrationMs === null
        ? { kind: "failed" }
        : { kind: "result", calibrationMs, lagMs: Math.round(median(errors)) },
    );
  }, [teardown]);

  // Must run inside the button's gesture so the AudioContext may start.
  const begin = useCallback(() => {
    teardown();
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      setStage({ kind: "failed" });
      return;
    }
    setAudioSessionType("playback");
    const ctx = new Ctor();
    ctxRef.current = ctx;
    void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime + START_DELAY_SEC;
    clicksRef.current = [];
    tapsRef.current = [];
    for (let i = 0; i < TOTAL_CLICKS; i++) {
      const at = t0 + i * BEAT_SEC;
      scheduleClick(ctx, at, i < TAP_TEST.leadInClicks && i % 4 === 0);
      clicksRef.current.push(at * 1000);
    }
    setStage({ kind: "running", scored: 0 });
    const endSec = START_DELAY_SEC + (TOTAL_CLICKS + 1) * BEAT_SEC;
    timerRef.current = window.setTimeout(finish, endSec * 1000);
  }, [finish, teardown]);

  const tap = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    tapsRef.current.push(ctx.currentTime * 1000);
    const scored = tapErrorsMs(tapsRef.current, clicksRef.current).length;
    setStage((s) => (s.kind === "running" && s.scored !== scored ? { ...s, scored } : s));
  }, []);

  // Desktop: any key taps (no auto-repeat).
  useEffect(() => {
    if (stage.kind !== "running") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.key === "Escape") return;
      e.preventDefault();
      tap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage.kind, tap]);

  return (
    <div className={classes.overlay} style={style}>
      <div className={classes.card}>
        <h2 className={classes.title}>Tap test</h2>

        {stage.kind === "intro" && (
          <>
            <p className={classes.subtitle}>
              Use the headphones or speakers you&apos;ll play with. You&apos;ll hear{" "}
              {TAP_TEST.leadInClicks} count-in clicks, then tap the pad on each of the
              next {TAP_TEST.measuredClicks}. Listen — there&apos;s no light to follow on
              purpose.
            </p>
            <div className={classes.actions}>
              <button type="button" className={classes.primary} onClick={begin}>
                Start
              </button>
              <button type="button" className={classes.secondary} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {stage.kind === "running" && (
          <>
            <p className={classes.subtitle}>
              {stage.scored === 0
                ? "Count-in… then tap on every click."
                : `${stage.scored} / ${TAP_TEST.measuredClicks}`}
            </p>
            <button
              type="button"
              className={styles.pad}
              onPointerDown={(e) => {
                e.preventDefault();
                tap();
              }}
            >
              TAP
            </button>
          </>
        )}

        {stage.kind === "result" && (
          <>
            <p className={classes.subtitle}>
              Your taps landed <strong>{Math.abs(stage.lagMs)} ms</strong>{" "}
              {stage.lagMs >= 0 ? "after" : "before"} the click
              {stage.lagMs >= 120 ? " — typical of Bluetooth audio" : ""}. Suggested
              calibration:
            </p>
            <div className={styles.result}>
              {stage.calibrationMs > 0 ? "+" : ""}
              {stage.calibrationMs} ms
            </div>
            <div className={classes.actions}>
              <button
                type="button"
                className={classes.primary}
                onClick={() => onApply(stage.calibrationMs)}
              >
                Use this
              </button>
              <button type="button" className={classes.secondary} onClick={begin}>
                Try again
              </button>
              <button type="button" className={classes.secondary} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {stage.kind === "failed" && (
          <>
            <p className={classes.subtitle}>
              Not enough steady taps to measure — tap once per click, right on the sound.
            </p>
            <div className={classes.actions}>
              <button type="button" className={classes.primary} onClick={begin}>
                Try again
              </button>
              <button type="button" className={classes.secondary} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
