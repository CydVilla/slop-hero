"use client";

/**
 * GameCanvas
 *
 * Imperative Canvas 2D renderer for the note highway. It owns the single
 * requestAnimationFrame loop for the game. Each frame it:
 *   1. reads the song time from the audio clock (a ref-backed getter),
 *   2. calls `onFrame` so the game hook can process misses/end-of-song,
 *   3. draws the highway from the chart + per-note runtime refs.
 *
 * Crucially it reads all high-frequency state from refs and NEVER calls
 * setState, so the animation loop produces zero React re-renders.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  FEEDBACK_DURATION_MS,
  LANE_COLORS,
  LANE_COUNT,
  LANE_FLASH_MS,
  LANE_GLOW_COLORS,
  LANES,
  NOTE_TRAVEL_MS,
} from "@/game/constants";
import { clamp, noteTravelProgress } from "@/game/timing";
import type {
  GamePhase,
  HitFeedback,
  Lane,
  NoteRuntimeState,
  RhythmChart,
} from "@/game/types";

interface GameCanvasProps {
  chart: RhythmChart;
  phase: GamePhase;
  getTimeMs: () => number;
  getCalibrationOffsetMs: () => number;
  runtimeRef: React.RefObject<Map<string, NoteRuntimeState>>;
  feedbackRef: React.RefObject<HitFeedback[]>;
  laneFlashRef: React.RefObject<Record<Lane, number>>;
  onFrame: (songTimeMs: number) => void;
  /**
   * Player pressed a lane column on the highway (finger/pointer down). This is
   * the primary touch input: it judges the note and begins any sustain.
   */
  onLanePress?: (lane: Lane) => void;
  /**
   * Player released a lane column (finger/pointer up). Resolves a sustain being
   * held in that lane. Optional — taps work without it.
   */
  onLaneRelease?: (lane: Lane) => void;
  /** Current combo, used to drive escalating "on fire" visuals. */
  combo?: number;
}

/** A short-lived touch ripple drawn where the player's finger landed. */
interface TapRipple {
  x: number;
  y: number;
  createdAtMs: number;
  color: string;
}

/** A single spark thrown off when a note is judged. */
interface Particle {
  x: number;
  y: number;
  /** Velocity in px/ms. */
  vx: number;
  vy: number;
  createdAtMs: number;
  lifeMs: number;
  size: number;
  color: string;
}

/** An expanding ring that pops at the hit pad on a successful hit. */
interface HitRing {
  cx: number;
  cy: number;
  createdAtMs: number;
  color: string;
  /** Scales ring size + brightness with the judgement quality. */
  strength: number;
}

const TAP_RIPPLE_MS = 360;
const PARTICLE_GRAVITY = 0.0011; // px/ms^2, pulls sparks back down
const HIT_RING_MS = 420;

const HIT_LINE_RATIO = 0.82; // hit line position from top (0..1)
const RATING_LABEL: Record<HitFeedback["rating"], string> = {
  perfect: "PERFECT",
  great: "GREAT",
  good: "GOOD",
  miss: "MISS",
};
const RATING_COLOR: Record<HitFeedback["rating"], string> = {
  perfect: "#fde047",
  great: "#4ade80",
  good: "#60a5fa",
  miss: "#f87171",
};

export function GameCanvas({
  chart,
  phase,
  getTimeMs,
  getCalibrationOffsetMs,
  runtimeRef,
  feedbackRef,
  laneFlashRef,
  onFrame,
  onLanePress,
  onLaneRelease,
  combo = 0,
}: GameCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripplesRef = useRef<TapRipple[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const ringsRef = useRef<HitRing[]>([]);
  // Which lane each active pointer is holding, so multi-touch chords/holds each
  // release the correct lane on pointer-up regardless of finger order.
  const pointerLanesRef = useRef<Map<number, Lane>>(new Map());
  // Feedback ids already turned into bursts, so each hit only sparks once even
  // though the feedback entry lingers for a few frames.
  const sparkedRef = useRef<Set<string>>(new Set());
  // Mirror frequently-changing props into refs so the rAF loop, which is set up
  // once, always sees the latest values without re-subscribing.
  const propsRef = useRef({
    chart,
    phase,
    getTimeMs,
    getCalibrationOffsetMs,
    onFrame,
    onLanePress,
    onLaneRelease,
    combo,
  });
  propsRef.current = {
    chart,
    phase,
    getTimeMs,
    getCalibrationOffsetMs,
    onFrame,
    onLanePress,
    onLaneRelease,
    combo,
  };

  // Pointer-down anywhere on the highway: figure out the lane column under the
  // finger, fire the press, and spawn a ripple at the touch point. Using
  // pointerdown (not click) keeps latency low, and each simultaneous finger
  // gets its own event so chords register. We capture the pointer so the
  // matching pointer-up still fires even if the finger slides off the canvas.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const { onLanePress: press, getTimeMs: getT } = propsRef.current;
      if (!press) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const laneW = rect.width / LANE_COUNT;
      const lane = Math.max(0, Math.min(LANE_COUNT - 1, Math.floor(x / laneW))) as Lane;
      pointerLanesRef.current.set(e.pointerId, lane);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort; releases still work via the map fallback.
      }
      press(lane);
      ripplesRef.current.push({
        x,
        y,
        createdAtMs: getT(),
        color: LANE_GLOW_COLORS[lane],
      });
      if (ripplesRef.current.length > 24) {
        ripplesRef.current = ripplesRef.current.slice(-24);
      }
    },
    [],
  );

  // Pointer-up / cancel: release the lane this pointer was holding so any
  // in-progress sustain resolves. Looked up by pointerId so the right lane is
  // released even with several fingers down at once.
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const lane = pointerLanesRef.current.get(e.pointerId);
      if (lane === undefined) return;
      pointerLanesRef.current.delete(e.pointerId);
      propsRef.current.onLaneRelease?.(lane);
    },
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let cssWidth = 0;
    let cssHeight = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = () => {
      const {
        chart: c,
        getTimeMs: getT,
        getCalibrationOffsetMs: getCal,
        onFrame: frame,
        combo: currentCombo,
      } = propsRef.current;

      const t = getT();
      frame(t);

      const cal = getCal();
      const w = cssWidth;
      const h = cssHeight;
      const laneW = w / LANE_COUNT;
      const hitLineY = h * HIT_LINE_RATIO;
      // 0 → 1 "heat" that ramps up with the combo and saturates around 50.
      const heat = clamp(currentCombo / 50, 0, 1);

      // Turn freshly-judged feedback entries into spark bursts + pop rings.
      spawnBurstsFromFeedback(
        feedbackRef.current,
        sparkedRef.current,
        particlesRef.current,
        ringsRef.current,
        laneW,
        hitLineY,
      );

      ctx.clearRect(0, 0, w, h);
      drawLanes(ctx, w, h, laneW, hitLineY, laneFlashRef.current, t);
      drawBeatLines(ctx, c, t, cal, w, hitLineY);
      drawNotes(ctx, c, t, cal, laneW, hitLineY, runtimeRef.current);
      drawHitLine(ctx, w, laneW, hitLineY, heat, t);
      drawHitRings(ctx, ringsRef.current, t);
      drawParticles(ctx, particlesRef.current, t);
      drawFeedback(ctx, feedbackRef.current, laneW, hitLineY, t);
      drawRipples(ctx, ripplesRef.current, laneW, t);
      drawComboGlow(ctx, w, h, heat, currentCombo, t);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [runtimeRef, feedbackRef, laneFlashRef]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      aria-label="Note highway — tap the lane under each note as it reaches the line; hold long notes until their tail clears"
    />
  );
}

function drawRipples(
  ctx: CanvasRenderingContext2D,
  ripples: TapRipple[] | null,
  laneW: number,
  t: number,
): void {
  if (!ripples || ripples.length === 0) return;
  const maxR = laneW * 0.5;
  for (const r of ripples) {
    const age = t - r.createdAtMs;
    if (age < 0 || age > TAP_RIPPLE_MS) continue;
    const k = age / TAP_RIPPLE_MS;
    const radius = maxR * (0.3 + 0.7 * k);
    const alpha = 1 - k;

    ctx.save();
    ctx.strokeStyle = rgba(r.color, 0.7 * alpha);
    ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = rgba(r.color, 0.18 * alpha);
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Faint horizontal lines that scroll down each lane in time with the beat,
 * giving the highway a sense of speed and pulse. Tied to the chart BPM so the
 * motion matches the music; falls back to 120 BPM when unknown.
 */
function drawBeatLines(
  ctx: CanvasRenderingContext2D,
  chart: RhythmChart,
  t: number,
  cal: number,
  w: number,
  hitLineY: number,
): void {
  const bpm = chart.bpm && chart.bpm > 0 ? chart.bpm : 120;
  const beatMs = 60000 / bpm;
  if (!Number.isFinite(beatMs) || beatMs <= 0) return;

  // Reuse the note travel math so beat lines move at the exact note speed.
  const reference = t + chart.offsetMs;
  const firstBeat = Math.floor((reference - hitLineY) / beatMs) * beatMs;

  ctx.save();
  ctx.lineWidth = 1;
  for (let i = -1; i < 12; i += 1) {
    const beatTime = firstBeat + i * beatMs;
    const progress = noteTravelProgress({ timeMs: beatTime }, t, chart.offsetMs, cal);
    if (progress < -0.05 || progress > 1.05) continue;
    const y = progress * hitLineY;
    // Brighter as it nears the hit line; every 4th beat (bar) is stronger.
    const isBar = Math.round(beatTime / beatMs) % 4 === 0;
    const alpha = (isBar ? 0.16 : 0.07) * clamp(progress + 0.15, 0, 1);
    ctx.strokeStyle = rgba("#ffffff", alpha);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Spawn a spark burst (and a pop ring for hits) for any new feedback entry. */
function spawnBurstsFromFeedback(
  feedback: HitFeedback[] | null,
  sparked: Set<string>,
  particles: Particle[],
  rings: HitRing[],
  laneW: number,
  hitLineY: number,
): void {
  if (!feedback) return;

  for (const f of feedback) {
    if (sparked.has(f.id)) continue;
    sparked.add(f.id);

    const cx = f.lane * laneW + laneW / 2;
    const isMiss = f.rating === "miss";
    const color = isMiss ? "#f87171" : LANE_GLOW_COLORS[f.lane];
    const strength = f.rating === "perfect" ? 1 : f.rating === "great" ? 0.8 : 0.6;

    if (isMiss) {
      // A small, sad downward puff.
      for (let i = 0; i < 5; i += 1) {
        particles.push({
          x: cx + (Math.random() - 0.5) * laneW * 0.3,
          y: hitLineY,
          vx: (Math.random() - 0.5) * 0.06,
          vy: 0.05 + Math.random() * 0.05,
          createdAtMs: f.createdAtMs,
          lifeMs: 360,
          size: 2 + Math.random() * 2,
          color,
        });
      }
      continue;
    }

    // Celebratory upward/outward fan of sparks for a hit.
    const count = Math.round(8 + strength * 8);
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = (0.12 + Math.random() * 0.32) * (0.7 + strength);
      particles.push({
        x: cx,
        y: hitLineY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        createdAtMs: f.createdAtMs,
        lifeMs: 420 + Math.random() * 260,
        size: 2 + Math.random() * 3 * (0.6 + strength),
        color: Math.random() < 0.3 ? "#ffffff" : color,
      });
    }
    rings.push({ cx, cy: hitLineY, createdAtMs: f.createdAtMs, color, strength });
  }

  // Keep the processed-id set from growing without bound.
  if (sparked.size > 96) {
    const live = new Set(feedback.map((f) => f.id));
    for (const id of sparked) if (!live.has(id)) sparked.delete(id);
  }
}

/** Integrate + render the spark particles, pruning dead ones in place. */
function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  t: number,
): void {
  if (particles.length === 0) return;

  let write = 0;
  ctx.save();
  for (let read = 0; read < particles.length; read += 1) {
    const p = particles[read];
    if (!p) continue;
    const age = t - p.createdAtMs;
    if (age < 0 || age > p.lifeMs) continue;
    // Survives → keep it (compact the array as we go).
    particles[write] = p;
    write += 1;

    const k = age / p.lifeMs;
    const x = p.x + p.vx * age;
    const y = p.y + p.vy * age + 0.5 * PARTICLE_GRAVITY * age * age;
    const alpha = 1 - k;
    const size = p.size * (1 - 0.5 * k);

    ctx.fillStyle = rgba(p.color, alpha);
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8 * alpha;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, size), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  particles.length = write;
}

/** Expanding rings that pop out of the pad on a successful hit. */
function drawHitRings(ctx: CanvasRenderingContext2D, rings: HitRing[], t: number): void {
  if (rings.length === 0) return;

  let write = 0;
  ctx.save();
  for (let read = 0; read < rings.length; read += 1) {
    const ring = rings[read];
    if (!ring) continue;
    const age = t - ring.createdAtMs;
    if (age < 0 || age > HIT_RING_MS) continue;
    rings[write] = ring;
    write += 1;

    const k = age / HIT_RING_MS;
    const radius = 14 + k * (60 + ring.strength * 50);
    const alpha = (1 - k) * (0.5 + 0.4 * ring.strength);
    ctx.strokeStyle = rgba(ring.color, alpha);
    ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.shadowColor = ring.color;
    ctx.shadowBlur = 12 * (1 - k);
    ctx.beginPath();
    ctx.arc(ring.cx, ring.cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  rings.length = write;
}

/**
 * A warm vignette + "ON FIRE" banner that grows with the combo, so a long
 * streak visibly heats up the whole highway.
 */
function drawComboGlow(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  heat: number,
  combo: number,
  t: number,
): void {
  if (heat <= 0) return;

  const pulse = 0.85 + 0.15 * Math.sin(t / 180);
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, `rgba(255, 140, 40, ${0.16 * heat * pulse})`);
  edge.addColorStop(0.22, "rgba(255, 140, 40, 0)");
  edge.addColorStop(0.8, "rgba(255, 90, 30, 0)");
  edge.addColorStop(1, `rgba(255, 90, 30, ${0.18 * heat * pulse})`);
  ctx.save();
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  // Side glows.
  const sideW = w * 0.12;
  const left = ctx.createLinearGradient(0, 0, sideW, 0);
  left.addColorStop(0, `rgba(255, 120, 40, ${0.14 * heat * pulse})`);
  left.addColorStop(1, "rgba(255, 120, 40, 0)");
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, sideW, h);
  const right = ctx.createLinearGradient(w, 0, w - sideW, 0);
  right.addColorStop(0, `rgba(255, 120, 40, ${0.14 * heat * pulse})`);
  right.addColorStop(1, "rgba(255, 120, 40, 0)");
  ctx.fillStyle = right;
  ctx.fillRect(w - sideW, 0, sideW, h);

  // Streak banner once the player is genuinely on a roll.
  if (combo >= 10) {
    ctx.globalAlpha = clamp(heat + 0.3, 0, 1) * pulse;
    ctx.fillStyle = "#ffd166";
    ctx.shadowColor = "rgba(255, 150, 40, 0.9)";
    ctx.shadowBlur = 18;
    ctx.font = `800 ${Math.min(22, w * 0.03)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${combo}x COMBO`, w / 2, 14);
  }
  ctx.restore();
}

function drawLanes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  laneW: number,
  hitLineY: number,
  laneFlash: Record<Lane, number> | null,
  t: number,
): void {
  for (const lane of LANES) {
    const x = lane * laneW;
    // Alternating subtle lane backgrounds for depth.
    ctx.fillStyle = lane % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.05)";
    ctx.fillRect(x, 0, laneW, h);

    // Lane separator.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    // Active-press glow rising from the hit line.
    const flashAt = laneFlash?.[lane] ?? -Infinity;
    const flashAge = t - flashAt;
    if (flashAge >= 0 && flashAge < LANE_FLASH_MS) {
      const alpha = 1 - flashAge / LANE_FLASH_MS;
      const grad = ctx.createLinearGradient(0, hitLineY, 0, hitLineY - h * 0.4);
      const color = LANE_GLOW_COLORS[lane];
      grad.addColorStop(0, hexWithAlpha(color, 0.55 * alpha));
      grad.addColorStop(1, hexWithAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x, hitLineY - h * 0.4, laneW, h * 0.4);
    }
  }
}

/** Gem radius for a given lane width — large enough to feel touch-friendly. */
function gemRadius(laneW: number): number {
  return Math.max(16, Math.min(laneW * 0.36, 52));
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  chart: RhythmChart,
  t: number,
  cal: number,
  laneW: number,
  hitLineY: number,
  runtime: Map<string, NoteRuntimeState> | null,
): void {
  const radius = gemRadius(laneW);
  const pxPerMs = hitLineY / NOTE_TRAVEL_MS;

  for (const note of chart.notes) {
    const state = runtime?.get(note.id);
    const cx = note.lane * laneW + laneW / 2;
    const color = LANE_COLORS[note.lane];

    // A sustain being held: pin the head at the hit line and shrink the tail to
    // show how much longer the player must keep pressing.
    if (state?.hold === "holding") {
      const endMs = note.timeMs + chart.offsetMs - cal + (note.durationMs ?? 0);
      const remainingMs = Math.max(0, endMs - t);
      const tail = Math.min(remainingMs * pxPerMs, hitLineY);
      drawActiveHold(ctx, cx, hitLineY, tail, radius, color, t);
      continue;
    }

    // Everything else that has been judged (tap, missed, completed/dropped
    // sustain) is done — stop drawing it.
    if (state?.judged) continue;

    const progress = noteTravelProgress(note, t, chart.offsetMs, cal);
    // Only draw notes that are on-screen (above the top a touch, below hit line).
    if (progress < -0.08 || progress > 1.12) continue;

    const y = progress * hitLineY;

    // Approaching notes brighten as they near the hit line.
    const nearness = clamp(progress, 0, 1);
    const alpha = 0.6 + 0.4 * nearness;

    // Sustain tail (trails above the gem), GH/RB style.
    if (note.durationMs && note.durationMs > 0) {
      const tail = Math.min(note.durationMs * pxPerMs, hitLineY);
      if (tail > radius * 0.5) {
        drawTail(ctx, cx, y, tail, radius * 0.62, color, alpha);
      }
    }

    drawGem(ctx, cx, y, radius, color, alpha);
  }
}

/**
 * A sustain currently being held: a bright, pulsing tail draining down into the
 * hit line with a glowing head locked at the pad, so it reads as "keep holding".
 */
function drawActiveHold(
  ctx: CanvasRenderingContext2D,
  cx: number,
  hitLineY: number,
  tail: number,
  radius: number,
  color: string,
  t: number,
): void {
  const pulse = 0.7 + 0.3 * Math.sin(t / 90);
  if (tail > 1) {
    ctx.save();
    const top = hitLineY - tail;
    const grad = ctx.createLinearGradient(0, top, 0, hitLineY);
    grad.addColorStop(0, rgba(color, 0.15 * pulse));
    grad.addColorStop(1, rgba(color, 0.85 * pulse, 0.25));
    ctx.fillStyle = grad;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 * pulse;
    const width = radius * 0.72;
    roundRect(ctx, cx - width / 2, top, width, tail, width / 2);
    ctx.fill();
    ctx.restore();
  }
  // Glowing head anchored at the pad.
  drawGem(ctx, cx, hitLineY, radius * (0.92 + 0.08 * pulse), color, 1);
}

/** A vertical rounded sustain bar trailing above the gem. */
function drawTail(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  length: number,
  width: number,
  color: string,
  alpha: number,
): void {
  const x = cx - width / 2;
  const top = cy - length;
  ctx.save();
  const grad = ctx.createLinearGradient(0, top, 0, cy);
  grad.addColorStop(0, rgba(color, 0.06 * alpha));
  grad.addColorStop(1, rgba(color, 0.5 * alpha));
  ctx.fillStyle = grad;
  roundRect(ctx, x, top, width, length, width / 2);
  ctx.fill();
  // Bright center seam.
  ctx.fillStyle = rgba(color, 0.5 * alpha, 0.55);
  const seam = Math.max(2, width * 0.2);
  roundRect(ctx, cx - seam / 2, top, seam, length, seam / 2);
  ctx.fill();
  ctx.restore();
}

/** A round, glossy Guitar Hero / Rock Band–style note gem. */
function drawGem(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  alpha: number,
): void {
  ctx.save();

  // Outer colored glow.
  ctx.shadowColor = color;
  ctx.shadowBlur = 20 * alpha;

  // Domed body: light top-left → color → darker rim.
  const body = ctx.createRadialGradient(
    cx - radius * 0.32,
    cy - radius * 0.38,
    radius * 0.12,
    cx,
    cy,
    radius,
  );
  body.addColorStop(0, rgba(color, alpha, 0.55));
  body.addColorStop(0.5, rgba(color, alpha, 0.05));
  body.addColorStop(1, rgba(color, alpha, -0.45));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // Crisp rim.
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, radius * 0.1);
  ctx.strokeStyle = rgba("#ffffff", 0.6 * alpha);
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.9, 0, Math.PI * 2);
  ctx.stroke();

  // Glossy specular highlight near the top.
  ctx.fillStyle = rgba("#ffffff", 0.5 * alpha);
  ctx.beginPath();
  ctx.ellipse(cx, cy - radius * 0.4, radius * 0.5, radius * 0.27, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawHitLine(
  ctx: CanvasRenderingContext2D,
  w: number,
  laneW: number,
  hitLineY: number,
  heat: number,
  t: number,
): void {
  // Horizontal hit line — brightens with the combo "heat".
  ctx.save();
  ctx.strokeStyle = rgba("#ffffff", 0.5 + 0.4 * heat);
  ctx.lineWidth = 2 + 2 * heat;
  if (heat > 0) {
    ctx.shadowColor = `rgba(255, 180, 60, ${0.6 * heat})`;
    ctx.shadowBlur = 16 * heat;
  }
  ctx.beginPath();
  ctx.moveTo(0, hitLineY);
  ctx.lineTo(w, hitLineY);
  ctx.stroke();
  ctx.restore();

  // A gentle breathing pulse so the pads feel alive even when idle.
  const pulse = 0.5 + 0.5 * Math.sin(t / 420);

  // Per-lane fret-pad targets (sized to match the gems).
  for (const lane of LANES) {
    const cx = lane * laneW + laneW / 2;
    const color = LANE_COLORS[lane];
    const r = gemRadius(laneW);

    ctx.save();
    // Recessed translucent pad the gem "lands" into.
    const pad = ctx.createRadialGradient(cx, hitLineY, r * 0.2, cx, hitLineY, r);
    pad.addColorStop(0, rgba(color, 0.22 + 0.18 * heat));
    pad.addColorStop(1, rgba(color, 0.04));
    ctx.fillStyle = pad;
    ctx.beginPath();
    ctx.arc(cx, hitLineY, r, 0, Math.PI * 2);
    ctx.fill();

    // Glowing rim — glow swells with heat and the idle pulse.
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + 18 * heat + 4 * pulse;
    ctx.beginPath();
    ctx.arc(cx, hitLineY, r, 0, Math.PI * 2);
    ctx.stroke();

    // Inner hairline ring for a "fret" look.
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba("#ffffff", 0.25);
    ctx.beginPath();
    ctx.arc(cx, hitLineY, r * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawFeedback(
  ctx: CanvasRenderingContext2D,
  feedback: HitFeedback[] | null,
  laneW: number,
  hitLineY: number,
  t: number,
): void {
  if (!feedback) return;
  for (const f of feedback) {
    const age = t - f.createdAtMs;
    if (age < 0 || age > FEEDBACK_DURATION_MS) continue;
    const k = age / FEEDBACK_DURATION_MS;
    const alpha = 1 - k;
    const rise = 42 * k;
    const cx = f.lane * laneW + laneW / 2;
    const cy = hitLineY - 40 - rise;

    const label = f.hold
      ? f.hold === "completed"
        ? "HOLD"
        : "DROP"
      : RATING_LABEL[f.rating];
    const fill = f.hold
      ? f.hold === "completed"
        ? "#4ade80"
        : "#f87171"
      : RATING_COLOR[f.rating];

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.font = `700 ${Math.min(20, laneW * 0.18)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}

/* ----------------------------- canvas helpers ----------------------------- */

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Apply an alpha to a #rrggbb hex color. */
function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/** Parse a #rrggbb hex color into rgb components. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Build an rgba() string from a #rrggbb hex with an alpha and optional shade.
 * `shade` > 0 lightens toward white, < 0 darkens toward black (range -1..1).
 */
function rgba(hex: string, alpha: number, shade = 0): string {
  let { r, g, b } = parseHex(hex);
  if (shade !== 0) {
    const target = shade > 0 ? 255 : 0;
    const f = Math.abs(shade);
    r = Math.round(r + (target - r) * f);
    g = Math.round(g + (target - g) * f);
    b = Math.round(b + (target - b) * f);
  }
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}
