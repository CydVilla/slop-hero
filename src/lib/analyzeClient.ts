"use client";

/**
 * Main-thread orchestration for audio analysis.
 *
 * Responsibilities:
 *  - decode the uploaded file to PCM with the Web Audio API,
 *  - downmix to mono,
 *  - hand the samples to the analysis worker (transferring the buffer so it's
 *    moved, not copied),
 *  - surface progress and resolve with the finished RhythmChart.
 *
 * The actual DSP lives in src/game/audioAnalysis.ts (pure) and runs inside
 * src/workers/analyzeWorker.ts (off the main thread).
 */

import type {
  AnalyzeRequest,
  AnalyzeResponse,
} from "@/workers/analyzeWorker";
import type { Difficulty, RhythmChart } from "@/game/types";

export interface AnalyzeFileOptions {
  difficulty: Difficulty;
  bpmHint?: number;
  title?: string;
  artist?: string;
  onProgress?: (progress: number) => void;
}

function getAudioContext(): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  return new Ctor();
}

/** Decode a file to a mono Float32Array + sample rate. */
async function decodeToMono(
  file: File,
): Promise<{ samples: Float32Array; sampleRate: number; durationSeconds: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const { numberOfChannels, length, sampleRate, duration } = audioBuffer;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i]! += data[i]!;
    }
    if (numberOfChannels > 1) {
      for (let i = 0; i < length; i++) mono[i]! /= numberOfChannels;
    }
    return { samples: mono, sampleRate, durationSeconds: duration };
  } finally {
    void ctx.close();
  }
}

/**
 * Decode + analyze a file into a RhythmChart. Rejects on decode failure or if
 * too few onsets were found (the caller should fall back to the grid automapper).
 */
export async function analyzeFileToChart(
  file: File,
  options: AnalyzeFileOptions,
): Promise<RhythmChart> {
  const { samples, sampleRate, durationSeconds } = await decodeToMono(file);

  return new Promise<RhythmChart>((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/analyzeWorker.ts", import.meta.url),
      { type: "module" },
    );

    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        options.onProgress?.(msg.value);
      } else if (msg.type === "done") {
        cleanup();
        resolve(msg.chart);
      } else {
        cleanup();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Analysis worker failed."));
    };

    const request: AnalyzeRequest = {
      samples,
      sampleRate,
      durationSeconds,
      difficulty: options.difficulty,
      bpmHint: options.bpmHint,
      title: options.title,
      artist: options.artist,
    };
    // Transfer the underlying buffer to avoid copying potentially large PCM.
    worker.postMessage(request, [samples.buffer]);
  });
}

// Cache analyzed charts so replaying / re-navigating to a built-in track doesn't
// re-decode and re-analyze the same audio every time.
const urlChartCache = new Map<string, RhythmChart>();

/**
 * Analyze audio at a same-origin URL (e.g. a built-in /tracks/*.mp3) into a
 * RhythmChart, with in-memory caching keyed by url + difficulty + bpm hint.
 */
export async function analyzeUrlToChart(
  url: string,
  options: AnalyzeFileOptions,
): Promise<RhythmChart> {
  const key = `${url}|${options.difficulty}|${options.bpmHint ?? ""}`;
  const cached = urlChartCache.get(key);
  if (cached) {
    options.onProgress?.(1);
    return cached;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch audio (${response.status}).`);
  const blob = await response.blob();
  const name = url.split("/").pop() || "track.mp3";
  const file = new File([blob], name, { type: blob.type || "audio/mpeg" });

  const chart = await analyzeFileToChart(file, options);
  urlChartCache.set(key, chart);
  return chart;
}
