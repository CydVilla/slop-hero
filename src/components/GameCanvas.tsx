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
  /** Player tapped a lane column on the highway (the primary touch input). */
  onLaneTap?: (lane: Lane) => void;
}

/** A short-lived touch ripple drawn where the player's finger landed. */
interface TapRipple {
  x: number;
  y: number;
  createdAtMs: number;
  color: string;
}

const TAP_RIPPLE_MS = 360;

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
  onLaneTap,
}: GameCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripplesRef = useRef<TapRipple[]>([]);
  // Mirror frequently-changing props into refs so the rAF loop, which is set up
  // once, always sees the latest values without re-subscribing.
  const propsRef = useRef({
    chart,
    phase,
    getTimeMs,
    getCalibrationOffsetMs,
    onFrame,
    onLaneTap,
  });
  propsRef.current = {
    chart,
    phase,
    getTimeMs,
    getCalibrationOffsetMs,
    onFrame,
    onLaneTap,
  };

  // Pointer-down anywhere on the highway: figure out the lane column under the
  // finger, fire the tap, and spawn a ripple at the touch point. Using
  // pointerdown (not click) keeps latency low, and each simultaneous finger
  // gets its own event so chords register.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const { onLaneTap: tap, getTimeMs: getT } = propsRef.current;
      if (!tap) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const laneW = rect.width / LANE_COUNT;
      const lane = Math.max(0, Math.min(LANE_COUNT - 1, Math.floor(x / laneW))) as Lane;
      tap(lane);
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
      } = propsRef.current;

      const t = getT();
      frame(t);

      const cal = getCal();
      const w = cssWidth;
      const h = cssHeight;
      const laneW = w / LANE_COUNT;
      const hitLineY = h * HIT_LINE_RATIO;

      ctx.clearRect(0, 0, w, h);
      drawLanes(ctx, w, h, laneW, hitLineY, laneFlashRef.current, t);
      drawNotes(ctx, c, t, cal, laneW, hitLineY, runtimeRef.current);
      drawHitLine(ctx, w, laneW, hitLineY);
      drawFeedback(ctx, feedbackRef.current, laneW, hitLineY, t);
      drawRipples(ctx, ripplesRef.current, laneW, t);

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
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
      aria-label="Note highway — tap the lane under each note as it reaches the line"
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
    if (runtime?.get(note.id)?.judged) continue;

    const progress = noteTravelProgress(note, t, chart.offsetMs, cal);
    // Only draw notes that are on-screen (above the top a touch, below hit line).
    if (progress < -0.08 || progress > 1.12) continue;

    const y = progress * hitLineY;
    const cx = note.lane * laneW + laneW / 2;
    const color = LANE_COLORS[note.lane];

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
): void {
  // Horizontal hit line.
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, hitLineY);
  ctx.lineTo(w, hitLineY);
  ctx.stroke();

  // Per-lane fret-pad targets (sized to match the gems).
  for (const lane of LANES) {
    const cx = lane * laneW + laneW / 2;
    const color = LANE_COLORS[lane];
    const r = gemRadius(laneW);

    ctx.save();
    // Recessed translucent pad the gem "lands" into.
    const pad = ctx.createRadialGradient(cx, hitLineY, r * 0.2, cx, hitLineY, r);
    pad.addColorStop(0, rgba(color, 0.22));
    pad.addColorStop(1, rgba(color, 0.04));
    ctx.fillStyle = pad;
    ctx.beginPath();
    ctx.arc(cx, hitLineY, r, 0, Math.PI * 2);
    ctx.fill();

    // Glowing rim.
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
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

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = RATING_COLOR[f.rating];
    ctx.font = `700 ${Math.min(20, laneW * 0.18)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(RATING_LABEL[f.rating], cx, cy);
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
