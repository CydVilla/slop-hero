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
 *
 * The highway is drawn in fake 3D, Guitar Hero style: a fretboard trapezoid
 * receding to a horizon, lanes converging on a vanishing point, and notes that
 * pop over the horizon small and slow, then swell and accelerate into the hit
 * line. All of that perspective lives in a handful of pure mapping helpers
 * (progress → depth → y / lane x / scale) shared by every draw pass AND by the
 * inverse touch mapping, so what you see is exactly what you tap.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  FEEDBACK_DURATION_MS,
  LANE_COLORS,
  LANE_COUNT,
  LANE_FLASH_MS,
  LANE_GLOW_COLORS,
  LANES,
  STAR_POWER,
  STAR_POWER_COLOR,
} from "@/game/constants";
import { starPowerMeterAt } from "@/game/starPower";
import { clamp, noteTravelProgress } from "@/game/timing";
import type {
  GamePhase,
  HitFeedback,
  Lane,
  NoteRuntimeState,
  RhythmChart,
  StarPowerState,
} from "@/game/types";

interface GameCanvasProps {
  chart: RhythmChart;
  phase: GamePhase;
  getTimeMs: () => number;
  getCalibrationOffsetMs: () => number;
  runtimeRef: React.RefObject<Map<string, NoteRuntimeState>>;
  feedbackRef: React.RefObject<HitFeedback[]>;
  laneFlashRef: React.RefObject<Record<Lane, number>>;
  /** Star power state, read per frame for the meter drain + active visuals. */
  starPowerRef: React.RefObject<StarPowerState>;
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
  /** Tapping the star-power meter (bottom center) unleashes banked star power. */
  onActivateStarPower?: () => void;
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

/* ------------------------------- perspective ------------------------------ */

/** Board width at the horizon, as a fraction of its width at the hit line. */
const BOARD_TOP_SCALE = 0.36;
/**
 * Progress → depth curve exponent. >1 makes notes crawl near the horizon and
 * accelerate into the hit line — the classic GH foreshortening.
 */
const PERSPECTIVE_EXP = 1.55;
/** Depth is extrapolated past the hit line, capped so the board stops widening. */
const MAX_DEPTH = 1.28;

/** Per-frame geometry bundle shared by every draw pass. */
interface Perspective {
  w: number;
  h: number;
  laneW: number;
  hitLineY: number;
  centerX: number;
}

function makePerspective(w: number, h: number): Perspective {
  return { w, h, laneW: w / LANE_COUNT, hitLineY: h * HIT_LINE_RATIO, centerX: w / 2 };
}

/**
 * Map linear note-travel progress (0 = spawn, 1 = hit line) to perspective
 * depth. Past the line the motion continues at the arrival speed so passed
 * notes exit briskly instead of snapping.
 */
function depthForProgress(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Math.min(1 + (p - 1) * PERSPECTIVE_EXP, MAX_DEPTH);
  return Math.pow(p, PERSPECTIVE_EXP);
}

/** Board width multiplier at a given depth (t = 0 horizon .. 1 hit line). */
function boardScaleAt(t: number): number {
  return BOARD_TOP_SCALE + (1 - BOARD_TOP_SCALE) * clamp(t, 0, MAX_DEPTH);
}

/** y-coordinate for a depth value. */
function yAtDepth(persp: Perspective, t: number): number {
  return t * persp.hitLineY;
}

/** Depth at a given y (inverse of yAtDepth), used by input and bottom edges. */
function depthAtY(persp: Perspective, y: number): number {
  if (persp.hitLineY <= 0) return 1;
  return clamp(y / persp.hitLineY, 0, MAX_DEPTH);
}

/** x of the center of `lane` at depth t. */
function laneCenterX(persp: Perspective, lane: number, t: number): number {
  const offset = (lane + 0.5 - LANE_COUNT / 2) * persp.laneW;
  return persp.centerX + offset * boardScaleAt(t);
}

/** x of lane boundary `edge` (0..LANE_COUNT) at depth t. */
function laneEdgeX(persp: Perspective, edge: number, t: number): number {
  const offset = (edge - LANE_COUNT / 2) * persp.laneW;
  return persp.centerX + offset * boardScaleAt(t);
}

/** Gem radius at the hit line for a given lane width — touch-friendly. */
function gemRadius(laneW: number): number {
  return Math.max(16, Math.min(laneW * 0.36, 52));
}

/** How much a gem (or tail width) shrinks with distance. */
function gemScaleAt(t: number): number {
  return 0.35 + 0.65 * clamp(t, 0, 1.15);
}

/** Inverse mapping for touch input: which lane sits under (x, y)? */
function laneAtPoint(persp: Perspective, x: number, y: number): Lane {
  const s = boardScaleAt(depthAtY(persp, y));
  const laneFloat = (x - persp.centerX) / (persp.laneW * s) + LANE_COUNT / 2;
  return clamp(Math.floor(laneFloat), 0, LANE_COUNT - 1) as Lane;
}

/* ------------------------- star power meter hitbox ------------------------ */

const SP_METER_WIDTH_RATIO = 0.44;
const SP_METER_HEIGHT = 12;
const SP_METER_BOTTOM_MARGIN = 18;
/** Extra slop around the drawn meter so it's easy to smack mid-song. */
const SP_METER_TAP_PAD = 16;

function inStarPowerMeter(w: number, h: number, x: number, y: number): boolean {
  const halfW = (w * SP_METER_WIDTH_RATIO) / 2 + SP_METER_TAP_PAD;
  const top = h - SP_METER_BOTTOM_MARGIN - SP_METER_HEIGHT - SP_METER_TAP_PAD;
  return y >= top && Math.abs(x - w / 2) <= halfW;
}

export function GameCanvas({
  chart,
  phase,
  getTimeMs,
  getCalibrationOffsetMs,
  runtimeRef,
  feedbackRef,
  laneFlashRef,
  starPowerRef,
  onFrame,
  onLanePress,
  onLaneRelease,
  onActivateStarPower,
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
    onActivateStarPower,
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
    onActivateStarPower,
    combo,
  };

  // Pointer-down anywhere on the highway: figure out the lane column under the
  // finger, fire the press, and spawn a ripple at the touch point. Using
  // pointerdown (not click) keeps latency low, and each simultaneous finger
  // gets its own event so chords register. We capture the pointer so the
  // matching pointer-up still fires even if the finger slides off the canvas.
  // A tap on the star-power meter (bottom center) activates star power instead.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const {
        onLanePress: press,
        onActivateStarPower: activate,
        getTimeMs: getT,
      } = propsRef.current;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (activate && inStarPowerMeter(rect.width, rect.height, x, y)) {
        activate();
        ripplesRef.current.push({
          x,
          y,
          createdAtMs: getT(),
          color: STAR_POWER_COLOR,
        });
        return;
      }

      if (!press) return;
      const persp = makePerspective(rect.width, rect.height);
      const lane = laneAtPoint(persp, x, y);
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
      const persp = makePerspective(cssWidth, cssHeight);
      // 0 → 1 "heat" that ramps up with the combo and saturates around 50.
      const heat = clamp(currentCombo / 50, 0, 1);
      const sp = starPowerRef.current;
      const spActive = Boolean(sp?.active);

      // Turn freshly-judged feedback entries into spark bursts + pop rings.
      spawnBurstsFromFeedback(
        feedbackRef.current,
        sparkedRef.current,
        particlesRef.current,
        ringsRef.current,
        persp,
      );

      ctx.clearRect(0, 0, persp.w, persp.h);
      drawBoard(ctx, persp, laneFlashRef.current, t, spActive);
      drawBeatLines(ctx, c, t, cal, persp);
      drawNotes(ctx, c, t, cal, persp, runtimeRef.current, spActive);
      drawHitLine(ctx, persp, heat, t, spActive);
      drawHitRings(ctx, ringsRef.current, t);
      drawParticles(ctx, particlesRef.current, t);
      drawFeedback(ctx, feedbackRef.current, persp, t);
      drawRipples(ctx, ripplesRef.current, persp.laneW, t);
      drawComboGlow(ctx, persp, heat, currentCombo, t, spActive);
      if (sp) drawStarPowerMeter(ctx, persp, sp, t);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [runtimeRef, feedbackRef, laneFlashRef, starPowerRef]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      aria-label="Note highway — tap the lane under each note as it reaches the line; hold long notes until their tail clears. Tap the glowing meter at the bottom to unleash star power."
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
 * The fretboard: a receding trapezoid with alternating lane shading, converging
 * separators, glowing side rails, and a bright horizon seam. Star power floods
 * the whole board electric blue.
 */
function drawBoard(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  laneFlash: Record<Lane, number> | null,
  t: number,
  spActive: boolean,
): void {
  const { h, hitLineY } = persp;
  const bottomT = depthAtY(persp, h);
  const railColor = spActive ? STAR_POWER_COLOR : "#8b5cf6";

  ctx.save();

  // Board surface: darkest at the horizon (distance haze), lifting toward the
  // player. Drawn as one trapezoid from horizon to the bottom of the canvas.
  const surface = ctx.createLinearGradient(0, 0, 0, h);
  if (spActive) {
    surface.addColorStop(0, "rgba(14, 42, 71, 0.9)");
    surface.addColorStop(0.7, "rgba(12, 46, 82, 0.55)");
    surface.addColorStop(1, "rgba(10, 36, 66, 0.45)");
  } else {
    surface.addColorStop(0, "rgba(10, 12, 24, 0.92)");
    surface.addColorStop(0.7, "rgba(20, 24, 44, 0.5)");
    surface.addColorStop(1, "rgba(16, 18, 36, 0.4)");
  }
  ctx.fillStyle = surface;
  boardQuad(ctx, persp, 0, LANE_COUNT, 0, bottomT);
  ctx.fill();

  // Alternating lane shading for depth (odd lanes slightly lighter).
  for (const lane of LANES) {
    if (lane % 2 === 0) continue;
    ctx.fillStyle = spActive ? "rgba(96, 165, 250, 0.06)" : "rgba(255, 255, 255, 0.04)";
    boardQuad(ctx, persp, lane, lane + 1, 0, bottomT);
    ctx.fill();
  }

  // Active-press glow rising from the hit line, clipped to the lane's quad so
  // it hugs the converging geometry.
  for (const lane of LANES) {
    const flashAt = laneFlash?.[lane] ?? -Infinity;
    const flashAge = t - flashAt;
    if (flashAge < 0 || flashAge >= LANE_FLASH_MS) continue;
    const alpha = 1 - flashAge / LANE_FLASH_MS;
    const topY = hitLineY * 0.55;
    ctx.save();
    boardQuad(ctx, persp, lane, lane + 1, depthAtY(persp, topY), 1);
    ctx.clip();
    const color = LANE_GLOW_COLORS[lane];
    const grad = ctx.createLinearGradient(0, hitLineY, 0, topY);
    grad.addColorStop(0, rgba(color, 0.55 * alpha));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, topY, persp.w, hitLineY - topY);
    ctx.restore();
  }

  // Lane separators, horizon → bottom.
  ctx.strokeStyle = spActive ? "rgba(125, 211, 252, 0.16)" : "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1;
  for (let edge = 1; edge < LANE_COUNT; edge += 1) {
    ctx.beginPath();
    ctx.moveTo(laneEdgeX(persp, edge, 0), 0);
    ctx.lineTo(laneEdgeX(persp, edge, bottomT), h);
    ctx.stroke();
  }

  // Glowing side rails framing the board.
  ctx.strokeStyle = rgba(railColor, spActive ? 0.85 : 0.5);
  ctx.lineWidth = 2.5;
  ctx.shadowColor = railColor;
  ctx.shadowBlur = spActive ? 18 : 10;
  for (const edge of [0, LANE_COUNT]) {
    ctx.beginPath();
    ctx.moveTo(laneEdgeX(persp, edge, 0), 0);
    ctx.lineTo(laneEdgeX(persp, edge, bottomT), h);
    ctx.stroke();
  }

  // Horizon seam the notes pop over.
  ctx.shadowBlur = 0;
  const seam = ctx.createLinearGradient(laneEdgeX(persp, 0, 0), 0, laneEdgeX(persp, LANE_COUNT, 0), 0);
  seam.addColorStop(0, rgba(railColor, 0));
  seam.addColorStop(0.5, rgba(railColor, spActive ? 0.8 : 0.45));
  seam.addColorStop(1, rgba(railColor, 0));
  ctx.strokeStyle = seam;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(laneEdgeX(persp, 0, 0), 1);
  ctx.lineTo(laneEdgeX(persp, LANE_COUNT, 0), 1);
  ctx.stroke();

  ctx.restore();
}

/** Path a lane-aligned quad between two depths (does not fill/stroke). */
function boardQuad(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  edgeLeft: number,
  edgeRight: number,
  tTop: number,
  tBottom: number,
): void {
  const yTop = yAtDepth(persp, tTop);
  const yBottom = yAtDepth(persp, tBottom);
  ctx.beginPath();
  ctx.moveTo(laneEdgeX(persp, edgeLeft, tTop), yTop);
  ctx.lineTo(laneEdgeX(persp, edgeRight, tTop), yTop);
  ctx.lineTo(laneEdgeX(persp, edgeRight, tBottom), yBottom);
  ctx.lineTo(laneEdgeX(persp, edgeLeft, tBottom), yBottom);
  ctx.closePath();
}

/**
 * Fret bars that scroll toward the player in time with the beat, brightening
 * as they approach — they ride the exact same perspective mapping as the
 * notes, which is most of what sells the 3D. Bar lines (every 4th beat) are
 * stronger. Falls back to 120 BPM when the chart doesn't know its tempo.
 */
function drawBeatLines(
  ctx: CanvasRenderingContext2D,
  chart: RhythmChart,
  t: number,
  cal: number,
  persp: Perspective,
): void {
  const bpm = chart.bpm && chart.bpm > 0 ? chart.bpm : 120;
  const beatMs = 60000 / bpm;
  if (!Number.isFinite(beatMs) || beatMs <= 0) return;

  // Chart-time window whose beats are visible (progress 0..~1.05).
  const nowChart = t - chart.offsetMs + cal;
  const first = Math.floor(nowChart / beatMs) * beatMs;

  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i += 1) {
    const beatTime = first + i * beatMs;
    const progress = noteTravelProgress({ timeMs: beatTime }, t, chart.offsetMs, cal);
    if (progress < 0 || progress > 1.02) continue;
    const depth = depthForProgress(progress);
    const y = yAtDepth(persp, depth);
    const isBar = Math.round(beatTime / beatMs) % 4 === 0;
    const alpha = (isBar ? 0.2 : 0.08) * clamp(depth + 0.1, 0, 1);
    ctx.strokeStyle = rgba("#ffffff", alpha);
    ctx.beginPath();
    ctx.moveTo(laneEdgeX(persp, 0, depth), y);
    ctx.lineTo(laneEdgeX(persp, LANE_COUNT, depth), y);
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
  persp: Perspective,
): void {
  if (!feedback) return;

  for (const f of feedback) {
    if (sparked.has(f.id)) continue;
    sparked.add(f.id);
    if (f.star) continue; // the star flare is text-only; the hit already sparked

    const cx = laneCenterX(persp, f.lane, 1);
    const cy = persp.hitLineY;
    const isMiss = f.rating === "miss";
    const color = isMiss ? "#f87171" : LANE_GLOW_COLORS[f.lane];
    const strength = f.rating === "perfect" ? 1 : f.rating === "great" ? 0.8 : 0.6;

    if (isMiss) {
      // A small, sad downward puff.
      for (let i = 0; i < 5; i += 1) {
        particles.push({
          x: cx + (Math.random() - 0.5) * persp.laneW * 0.3,
          y: cy,
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
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        createdAtMs: f.createdAtMs,
        lifeMs: 420 + Math.random() * 260,
        size: 2 + Math.random() * 3 * (0.6 + strength),
        color: Math.random() < 0.3 ? "#ffffff" : color,
      });
    }
    rings.push({ cx, cy, createdAtMs: f.createdAtMs, color, strength });
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
 * A warm vignette + streak banner that grows with the combo, so a long run
 * visibly heats up the whole highway. While star power blazes the fire turns
 * electric blue and the banner celebrates it.
 */
function drawComboGlow(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  heat: number,
  combo: number,
  t: number,
  spActive: boolean,
): void {
  const { w, h } = persp;
  const glow = spActive ? Math.max(heat, 0.7) : heat;
  if (glow <= 0) return;

  const pulse = 0.85 + 0.15 * Math.sin(t / 180);
  const [edgeRGB, sideRGB] = spActive
    ? (["56, 189, 248", "56, 189, 248"] as const)
    : (["255, 140, 40", "255, 120, 40"] as const);
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, `rgba(${edgeRGB}, ${0.16 * glow * pulse})`);
  edge.addColorStop(0.22, `rgba(${edgeRGB}, 0)`);
  edge.addColorStop(0.8, `rgba(${edgeRGB}, 0)`);
  edge.addColorStop(1, `rgba(${edgeRGB}, ${0.18 * glow * pulse})`);
  ctx.save();
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  // Side glows.
  const sideW = w * 0.12;
  const left = ctx.createLinearGradient(0, 0, sideW, 0);
  left.addColorStop(0, `rgba(${sideRGB}, ${0.14 * glow * pulse})`);
  left.addColorStop(1, `rgba(${sideRGB}, 0)`);
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, sideW, h);
  const right = ctx.createLinearGradient(w, 0, w - sideW, 0);
  right.addColorStop(0, `rgba(${sideRGB}, ${0.14 * glow * pulse})`);
  right.addColorStop(1, `rgba(${sideRGB}, 0)`);
  ctx.fillStyle = right;
  ctx.fillRect(w - sideW, 0, sideW, h);

  // Streak banner once the player is genuinely on a roll.
  if (combo >= 10 || spActive) {
    ctx.globalAlpha = clamp(glow + 0.3, 0, 1) * pulse;
    ctx.fillStyle = spActive ? "#7dd3fc" : "#ffd166";
    ctx.shadowColor = spActive ? "rgba(56, 189, 248, 0.9)" : "rgba(255, 150, 40, 0.9)";
    ctx.shadowBlur = 18;
    ctx.font = `800 ${Math.min(22, w * 0.03)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const label = spActive
      ? combo >= 10
        ? `★ ${combo}x STAR POWER ★`
        : "★ STAR POWER ★"
      : `${combo}x COMBO`;
    ctx.fillText(label, w / 2, 14);
  }
  ctx.restore();
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  chart: RhythmChart,
  t: number,
  cal: number,
  persp: Perspective,
  runtime: Map<string, NoteRuntimeState> | null,
  spActive: boolean,
): void {
  const baseRadius = gemRadius(persp.laneW);

  for (const note of chart.notes) {
    const state = runtime?.get(note.id);
    const isStar = note.starPhrase !== undefined;
    // Star power washes every gem electric blue, GH style; star notes keep
    // their white star overlay so charged phrases still read.
    const color = spActive
      ? blendHex(LANE_COLORS[note.lane], STAR_POWER_COLOR, 0.6)
      : LANE_COLORS[note.lane];

    // A sustain being held: pin the head at the hit line and shrink the tail to
    // show how much longer the player must keep pressing.
    if (state?.hold === "holding") {
      const endProgress = noteTravelProgress(
        { timeMs: note.timeMs + (note.durationMs ?? 0) },
        t,
        chart.offsetMs,
        cal,
      );
      drawActiveHold(ctx, persp, note.lane, endProgress, baseRadius, color, t);
      continue;
    }

    // Everything else that has been judged (tap, missed, completed/dropped
    // sustain) is done — stop drawing it.
    if (state?.judged) continue;

    const progress = noteTravelProgress(note, t, chart.offsetMs, cal);
    // Draw only what's between the horizon (0) and just past the hit line.
    if (progress < 0 || progress > 1.12) continue;

    const depth = depthForProgress(progress);
    const y = yAtDepth(persp, depth);
    const cx = laneCenterX(persp, note.lane, depth);
    const radius = baseRadius * gemScaleAt(depth);

    // Approaching notes brighten as they near the hit line.
    const alpha = 0.55 + 0.45 * clamp(depth, 0, 1);

    // Sustain tail (trails above the gem toward the horizon), GH/RB style.
    if (note.durationMs && note.durationMs > 0) {
      const endProgress = noteTravelProgress(
        { timeMs: note.timeMs + note.durationMs },
        t,
        chart.offsetMs,
        cal,
      );
      drawTail(ctx, persp, note.lane, endProgress, depth, color, alpha);
    }

    drawGem(ctx, cx, y, radius, color, alpha);
    if (isStar) drawStarOverlay(ctx, cx, y, radius, alpha);
  }
}

/**
 * A sustain currently being held: a bright, pulsing tail draining down into the
 * hit line with a glowing head locked at the pad, so it reads as "keep holding".
 */
function drawActiveHold(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  lane: Lane,
  endProgress: number,
  baseRadius: number,
  color: string,
  t: number,
): void {
  const pulse = 0.7 + 0.3 * Math.sin(t / 90);
  const headDepth = 1;
  const tailDepth = clamp(depthForProgress(endProgress), 0, headDepth);
  if (headDepth - tailDepth > 0.005) {
    ctx.save();
    const yTop = yAtDepth(persp, tailDepth);
    const yHead = persp.hitLineY;
    const grad = ctx.createLinearGradient(0, yTop, 0, yHead);
    grad.addColorStop(0, rgba(color, 0.15 * pulse));
    grad.addColorStop(1, rgba(color, 0.85 * pulse, 0.25));
    ctx.fillStyle = grad;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 * pulse;
    tailQuad(ctx, persp, lane, tailDepth, headDepth, baseRadius * 0.72);
    ctx.fill();
    ctx.restore();
  }
  // Glowing head anchored at the pad.
  drawGem(
    ctx,
    laneCenterX(persp, lane, 1),
    persp.hitLineY,
    baseRadius * (0.92 + 0.08 * pulse),
    color,
    1,
  );
}

/**
 * A sustain tail from the gem (at `headDepth`) up toward the horizon. Follows
 * the lane's convergence: narrower and pulled toward the center with distance.
 */
function drawTail(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  lane: Lane,
  endProgress: number,
  headDepth: number,
  color: string,
  alpha: number,
): void {
  const tailDepth = clamp(depthForProgress(endProgress), 0, headDepth);
  if (headDepth - tailDepth < 0.01) return;
  const yTop = yAtDepth(persp, tailDepth);
  const yHead = yAtDepth(persp, headDepth);
  ctx.save();
  const grad = ctx.createLinearGradient(0, yTop, 0, yHead);
  grad.addColorStop(0, rgba(color, 0.06 * alpha));
  grad.addColorStop(1, rgba(color, 0.5 * alpha));
  ctx.fillStyle = grad;
  tailQuad(ctx, persp, lane, tailDepth, headDepth, gemRadius(persp.laneW) * 0.62);
  ctx.fill();
  ctx.restore();
}

/** Path a tapered tail quad along a lane's center line between two depths. */
function tailQuad(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  lane: Lane,
  tTop: number,
  tBottom: number,
  baseWidth: number,
): void {
  const yTop = yAtDepth(persp, tTop);
  const yBottom = yAtDepth(persp, tBottom);
  const cxTop = laneCenterX(persp, lane, tTop);
  const cxBottom = laneCenterX(persp, lane, tBottom);
  const halfTop = (baseWidth * gemScaleAt(tTop)) / 2;
  const halfBottom = (baseWidth * gemScaleAt(tBottom)) / 2;
  ctx.beginPath();
  ctx.moveTo(cxTop - halfTop, yTop);
  ctx.lineTo(cxTop + halfTop, yTop);
  ctx.lineTo(cxBottom + halfBottom, yBottom);
  ctx.lineTo(cxBottom - halfBottom, yBottom);
  ctx.closePath();
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

/** The white star stamped on star-phrase gems (GH's star notes). */
function drawStarOverlay(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  alpha: number,
): void {
  ctx.save();
  ctx.fillStyle = rgba("#ffffff", 0.95 * alpha);
  ctx.shadowColor = STAR_POWER_COLOR;
  ctx.shadowBlur = 10 * alpha;
  starPath(ctx, cx, cy, radius * 0.66, radius * 0.28);
  ctx.fill();
  ctx.restore();
}

/** Path a five-point star centred on (cx, cy) (does not fill/stroke). */
function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHitLine(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  heat: number,
  t: number,
  spActive: boolean,
): void {
  const { laneW, hitLineY } = persp;
  const lineColor = spActive ? STAR_POWER_COLOR : "#ffffff";

  // Horizontal hit line — brightens with the combo "heat".
  ctx.save();
  ctx.strokeStyle = rgba(lineColor, 0.5 + 0.4 * heat);
  ctx.lineWidth = 2 + 2 * heat;
  if (heat > 0 || spActive) {
    ctx.shadowColor = spActive
      ? "rgba(56, 189, 248, 0.8)"
      : `rgba(255, 180, 60, ${0.6 * heat})`;
    ctx.shadowBlur = spActive ? 18 : 16 * heat;
  }
  ctx.beginPath();
  ctx.moveTo(laneEdgeX(persp, 0, 1), hitLineY);
  ctx.lineTo(laneEdgeX(persp, LANE_COUNT, 1), hitLineY);
  ctx.stroke();
  ctx.restore();

  // A gentle breathing pulse so the pads feel alive even when idle.
  const pulse = 0.5 + 0.5 * Math.sin(t / 420);

  // Per-lane fret-pad targets (sized to match the gems).
  for (const lane of LANES) {
    const cx = laneCenterX(persp, lane, 1);
    const color = spActive
      ? blendHex(LANE_COLORS[lane], STAR_POWER_COLOR, 0.5)
      : LANE_COLORS[lane];
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

/**
 * The star-power meter pinned to the bottom center: fills as phrases complete,
 * pulses when charged enough to unleash, and drains while blazing. Tapping it
 * (see inStarPowerMeter) activates.
 */
function drawStarPowerMeter(
  ctx: CanvasRenderingContext2D,
  persp: Perspective,
  sp: StarPowerState,
  t: number,
): void {
  const { w, h } = persp;
  const meter = starPowerMeterAt(sp, t);
  if (meter <= 0 && !sp.active) {
    // Nothing banked: draw only a faint track so players learn where it lives.
    ctx.save();
    ctx.globalAlpha = 0.5;
  } else {
    ctx.save();
  }

  const width = w * SP_METER_WIDTH_RATIO;
  const x = (w - width) / 2;
  const y = h - SP_METER_BOTTOM_MARGIN - SP_METER_HEIGHT;
  const ready = !sp.active && meter >= STAR_POWER.activationMin;
  const pulse = 0.75 + 0.25 * Math.sin(t / 140);

  // Track.
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  roundRect(ctx, x, y, width, SP_METER_HEIGHT, SP_METER_HEIGHT / 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, SP_METER_HEIGHT, SP_METER_HEIGHT / 2);
  ctx.stroke();

  // Fill.
  if (meter > 0) {
    const glow = sp.active ? pulse : ready ? 0.6 + 0.4 * pulse : 0.35;
    ctx.fillStyle = rgba(STAR_POWER_COLOR, 0.55 + 0.45 * glow);
    ctx.shadowColor = STAR_POWER_COLOR;
    ctx.shadowBlur = sp.active || ready ? 14 * glow : 4;
    roundRect(ctx, x, y, width * meter, SP_METER_HEIGHT, SP_METER_HEIGHT / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Activation-threshold notch.
  const notchX = x + width * STAR_POWER.activationMin;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
  ctx.beginPath();
  ctx.moveTo(notchX, y - 2);
  ctx.lineTo(notchX, y + SP_METER_HEIGHT + 2);
  ctx.stroke();

  // Label above the bar.
  const label = sp.active ? "★ STAR POWER ★" : ready ? "TAP FOR STAR POWER" : "STAR POWER";
  ctx.fillStyle = ready || sp.active ? rgba(STAR_POWER_COLOR, 0.7 + 0.3 * pulse) : "rgba(255,255,255,0.35)";
  ctx.font = `800 11px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, w / 2, y - 5);

  ctx.restore();
}

function drawFeedback(
  ctx: CanvasRenderingContext2D,
  feedback: HitFeedback[] | null,
  persp: Perspective,
  t: number,
): void {
  if (!feedback) return;
  const { laneW, hitLineY } = persp;
  for (const f of feedback) {
    const age = t - f.createdAtMs;
    if (age < 0 || age > FEEDBACK_DURATION_MS) continue;
    const k = age / FEEDBACK_DURATION_MS;
    const alpha = 1 - k;
    const cx = laneCenterX(persp, f.lane, 1);

    // The celebratory phrase-complete flare rides higher and bigger than the
    // per-hit rating so both can show for the same note.
    if (f.star) {
      const rise = 60 * k;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = STAR_POWER_COLOR;
      ctx.shadowColor = STAR_POWER_COLOR;
      ctx.shadowBlur = 14;
      ctx.font = `800 ${Math.min(24, laneW * 0.24)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("★ STAR POWER +25% ★", cx, hitLineY - 96 - rise);
      ctx.restore();
      continue;
    }

    const rise = 42 * k;
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

/** Parse a #rrggbb hex color into rgb components. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Blend two #rrggbb colors: k = 0 → a, k = 1 → b. */
function blendHex(a: string, b: string, k: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const mix = (x: number, y: number) =>
    Math.round(x + (y - x) * clamp(k, 0, 1))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(ca.r, cb.r)}${mix(ca.g, cb.g)}${mix(ca.b, cb.b)}`;
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
