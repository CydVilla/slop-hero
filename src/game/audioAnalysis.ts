/**
 * Client-side audio analysis → chart generation.
 *
 * This is the "real" automapper: instead of placing notes on a fixed BPM grid,
 * it analyzes the decoded PCM and places notes on detected musical onsets. It is
 * deliberately dependency-free (a compact radix-2 FFT + spectral-flux onset
 * detection) so it runs reliably in a Web Worker on the Tesla browser with no
 * WASM/native deps to ship or break.
 *
 * Everything here is PURE: it takes Float32 samples in and returns data out, so
 * it can be unit-tested and runs identically on the main thread or in a worker.
 *
 * Pipeline:
 *   PCM (mono) -> framed STFT magnitudes -> spectral flux (onset strength)
 *             -> adaptive peak picking (onset times + strength + brightness)
 *             -> tempo estimate (autocorrelation, informational)
 *             -> difficulty-aware selection + lane assignment -> RhythmChart
 *
 * See docs/aiChartGenerationPlan.md for how this maps onto the larger roadmap
 * (and how a server pipeline could later replace it behind the same output).
 */

import { makeNoteId } from "./chartUtils";
import type { ChartNote, Difficulty, Lane, RhythmChart } from "./types";

/* --------------------------------- FFT ----------------------------------- */

/** In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be 2^k. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]!;
        const bIm = im[i + k + half]!;
        const vRe = bRe * wRe - bIm * wIm;
        const vIm = bRe * wIm + bIm * wRe;
        re[i + k] = aRe + vRe;
        im[i + k] = aIm + vIm;
        re[i + k + half] = aRe - vRe;
        im[i + k + half] = aIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

/** Periodic Hann window of the given size. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}

/* ------------------------------ Onset detection --------------------------- */

export interface Onset {
  timeMs: number;
  /** Spectral-flux strength at the peak (normalized 0..1-ish). */
  strength: number;
  /** Spectral centroid (0..1, low=bassy, high=bright) for lane assignment. */
  brightness: number;
}

export interface OnsetAnalysis {
  onsets: Onset[];
  /** Estimated tempo in BPM (informational; charting is onset-driven). */
  bpm: number;
}

export interface AnalyzeOnsetOptions {
  fftSize?: number;
  hopSize?: number;
  /** Called with 0..1 progress during the (longest) STFT pass. */
  onProgress?: (progress: number) => void;
}

/**
 * Compute onsets from mono PCM via spectral flux + adaptive peak picking.
 */
export function analyzeOnsets(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeOnsetOptions = {},
): OnsetAnalysis {
  const fftSize = options.fftSize ?? 1024;
  const hop = options.hopSize ?? 512;
  const bins = fftSize >> 1;
  const win = hannWindow(fftSize);

  const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  if (frameCount <= 2) {
    return { onsets: [], bpm: 0 };
  }

  const flux = new Float32Array(frameCount);
  const brightness = new Float32Array(frameCount);

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  let prevMag = new Float32Array(bins);
  let mag = new Float32Array(bins);

  const progressEvery = Math.max(1, Math.floor(frameCount / 20));

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);

    let fluxSum = 0;
    let magSum = 0;
    let centroidSum = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      mag[k] = m;
      const diff = m - prevMag[k]!;
      if (diff > 0) fluxSum += diff;
      magSum += m;
      centroidSum += k * m;
    }
    flux[f] = fluxSum;
    brightness[f] = magSum > 0 ? centroidSum / magSum / bins : 0;

    // Swap mag buffers (reuse allocations).
    const tmp = prevMag;
    prevMag = mag;
    mag = tmp;

    if (options.onProgress && f % progressEvery === 0) {
      options.onProgress(f / frameCount);
    }
  }

  // Normalize flux to 0..1.
  let maxFlux = 0;
  for (let f = 0; f < frameCount; f++) {
    if (flux[f]! > maxFlux) maxFlux = flux[f]!;
  }
  if (maxFlux > 0) {
    for (let f = 0; f < frameCount; f++) flux[f]! /= maxFlux;
  }

  const onsets = pickPeaks(flux, brightness, sampleRate, hop);
  const bpm = estimateTempo(flux, sampleRate, hop);
  options.onProgress?.(1);
  return { onsets, bpm };
}

/**
 * Adaptive peak picking: a frame is an onset if it is a local maximum and
 * exceeds a local moving average by a margin, with a minimum spacing to avoid
 * double-triggering on a single transient.
 */
function pickPeaks(
  flux: Float32Array,
  brightness: Float32Array,
  sampleRate: number,
  hop: number,
): Onset[] {
  const frameMs = (hop / sampleRate) * 1000;
  const window = 8; // frames each side for the local average
  const delta = 0.06; // required margin above local average
  const minGapMs = 70; // hard floor between any two onsets
  const onsets: Onset[] = [];
  let lastMs = -Infinity;

  for (let f = 1; f < flux.length - 1; f++) {
    const v = flux[f]!;
    if (v < flux[f - 1]! || v < flux[f + 1]!) continue; // not a local max

    let sum = 0;
    let count = 0;
    const lo = Math.max(0, f - window);
    const hi = Math.min(flux.length - 1, f + window);
    for (let i = lo; i <= hi; i++) {
      sum += flux[i]!;
      count++;
    }
    const localMean = count > 0 ? sum / count : 0;
    if (v < localMean + delta) continue;

    const timeMs = f * frameMs;
    if (timeMs - lastMs < minGapMs) {
      // Keep the stronger of the two if too close.
      const last = onsets[onsets.length - 1];
      if (last && v > last.strength) {
        last.timeMs = timeMs;
        last.strength = v;
        last.brightness = brightness[f]!;
        lastMs = timeMs;
      }
      continue;
    }

    onsets.push({ timeMs, strength: v, brightness: brightness[f]! });
    lastMs = timeMs;
  }

  return onsets;
}

/**
 * Estimate tempo by autocorrelating the onset-strength envelope and finding the
 * lag (within a musical range) with the strongest periodicity.
 */
export function estimateTempo(
  flux: Float32Array,
  sampleRate: number,
  hop: number,
): number {
  const frameRate = sampleRate / hop; // frames per second
  const minBpm = 70;
  const maxBpm = 190;
  const minLag = Math.floor((frameRate * 60) / maxBpm);
  const maxLag = Math.ceil((frameRate * 60) / minBpm);

  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = lag; i < flux.length; i++) {
      score += flux[i]! * flux[i - lag]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return 0;
  return Math.round((frameRate * 60) / bestLag);
}

/* --------------------------- Chart construction --------------------------- */

interface OnsetChartProfile {
  /** Minimum spacing between kept notes (ms). */
  minGapMs: number;
  /** Fraction of the strongest onsets to keep (0..1). */
  keepFraction: number;
}

// Tuned for tap-the-note touchscreen play. The previous values allowed notes
// as close as 100ms apart (~10/s) which is impossible when the finger has to
// travel to each gem; these enforce a much larger minimum spacing and keep a
// smaller fraction of onsets so charts stay readable and reachable.
const ONSET_PROFILES: Record<Difficulty, OnsetChartProfile> = {
  easy: { minGapMs: 450, keepFraction: 0.3 },
  medium: { minGapMs: 340, keepFraction: 0.45 },
  hard: { minGapMs: 260, keepFraction: 0.6 },
  expert: { minGapMs: 200, keepFraction: 0.78 },
};

const LANE_COUNT = 5;

function strengthCutoff(strengths: number[], keepFraction: number): number {
  if (strengths.length === 0) return 0;
  const sorted = [...strengths].sort((a, b) => a - b);
  const idx = Math.floor((1 - keepFraction) * sorted.length);
  const clamped = Math.min(Math.max(idx, 0), sorted.length - 1);
  return sorted[clamped] ?? 0;
}

export interface BuildChartOptions {
  difficulty: Difficulty;
  durationSeconds: number;
  bpm?: number;
  title?: string;
  artist?: string;
}

/**
 * Turn detected onsets into a playable RhythmChart: threshold by strength,
 * enforce a per-difficulty minimum gap, then assign lanes from brightness
 * (range-normalized so each song uses the full lane spread) while avoiding
 * immediate same-lane repeats.
 */
export function buildChartFromOnsets(
  onsets: readonly Onset[],
  options: BuildChartOptions,
): RhythmChart {
  const profile = ONSET_PROFILES[options.difficulty];

  const cutoff = strengthCutoff(
    onsets.map((o) => o.strength),
    profile.keepFraction,
  );

  // Threshold + min-gap (greedy over time-sorted onsets).
  const sorted = [...onsets].sort((a, b) => a.timeMs - b.timeMs);
  const kept: Onset[] = [];
  let lastMs = -Infinity;
  for (const o of sorted) {
    if (o.strength < cutoff) continue;
    if (o.timeMs - lastMs < profile.minGapMs) continue;
    kept.push(o);
    lastMs = o.timeMs;
  }

  // Range-normalize brightness so lanes use the full 0..4 spread per-song.
  let minB = Infinity;
  let maxB = -Infinity;
  for (const o of kept) {
    if (o.brightness < minB) minB = o.brightness;
    if (o.brightness > maxB) maxB = o.brightness;
  }
  const span = maxB - minB;

  const notes: ChartNote[] = [];
  let prevLane = -1;
  kept.forEach((o, index) => {
    let lane: number;
    if (span > 1e-6) {
      lane = Math.floor(((o.brightness - minB) / span) * LANE_COUNT);
    } else {
      lane = index % LANE_COUNT;
    }
    lane = Math.min(Math.max(lane, 0), LANE_COUNT - 1);
    if (lane === prevLane) lane = (lane + 1) % LANE_COUNT;
    prevLane = lane;

    notes.push({
      id: makeNoteId("an"),
      timeMs: Math.round(o.timeMs),
      lane: lane as Lane,
      type: "tap",
    });
  });

  return {
    id: `analyzed_${options.difficulty}_${Math.round(options.durationSeconds)}`,
    title: options.title ?? "Uploaded Song",
    artist: options.artist,
    bpm: options.bpm,
    offsetMs: 0,
    difficulty: options.difficulty,
    notes,
  };
}

export interface AnalyzeToChartOptions extends BuildChartOptions {
  onProgress?: (progress: number) => void;
  /** Used as fallback tempo if detection fails. */
  bpmHint?: number;
}

/** Minimum onsets for a result to be considered usable (else caller falls back). */
export const MIN_USABLE_ONSETS = 8;

/**
 * End-to-end: PCM → RhythmChart. Throws if too few onsets were found so the
 * caller can fall back to the grid automapper.
 */
export function analyzePcmToChart(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeToChartOptions,
): RhythmChart {
  const { onsets, bpm } = analyzeOnsets(samples, sampleRate, {
    onProgress: options.onProgress,
  });

  if (onsets.length < MIN_USABLE_ONSETS) {
    throw new Error(
      `Audio analysis found too few onsets (${onsets.length}); falling back.`,
    );
  }

  return buildChartFromOnsets(onsets, {
    difficulty: options.difficulty,
    durationSeconds: options.durationSeconds,
    bpm: bpm > 0 ? bpm : options.bpmHint,
    title: options.title,
    artist: options.artist,
  });
}
