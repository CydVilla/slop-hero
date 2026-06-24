"use client";

/**
 * Browser-side intake for Clone Hero songs.
 *
 * Accepts either a song-folder `.zip` (containing song.ini + notes.chart/.mid +
 * audio) or a bare `.chart` / `.mid` file. It unzips in-browser (fflate), locates
 * the relevant files, parses metadata + available difficulties, and creates a
 * blob: URL for the audio so the song hands off to /play exactly like an upload.
 *
 * Heavy/pure parsing lives in src/game/cloneHeroParser.ts.
 */

import { unzipSync, strFromU8 } from "fflate";

import {
  importCloneHeroSong,
  listChartDifficulties,
  listMidiDifficulties,
  readChartMetadata,
  parseSongIni,
  type CloneHeroSongMetadata,
} from "@/game/cloneHeroParser";
import { parseSng } from "@/game/sngParser";
import type { Difficulty, RhythmChart } from "@/game/types";

export interface CloneHeroPackage {
  fileName: string;
  metadata: CloneHeroSongMetadata;
  availableDifficulties: Difficulty[];
  format: "chart" | "midi";
  audioUrl?: string;
  /** Parsed sources retained for the import step. */
  chartText?: string;
  midiBytes?: ArrayBuffer;
}

const AUDIO_EXT = ["ogg", "opus", "mp3", "wav", "m4a"];
const AUDIO_MIME: Record<string, string> = {
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? path).toLowerCase();
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Choose the best audio entry: prefer song.*, else guitar.*, else any audio. */
function pickAudioEntry(
  entries: Record<string, Uint8Array>,
): { bytes: Uint8Array; ext: string } | undefined {
  const audio = Object.keys(entries).filter((k) => AUDIO_EXT.includes(extOf(basename(k))));
  if (audio.length === 0) return undefined;
  const prefer = (stem: string) =>
    audio.find((k) => basename(k).startsWith(stem));
  const chosen = prefer("song") ?? prefer("guitar") ?? audio[0]!;
  return { bytes: entries[chosen]!, ext: extOf(basename(chosen)) };
}

function audioUrlFrom(bytes: Uint8Array, ext: string): string {
  const type = AUDIO_MIME[ext] ?? "audio/*";
  // Copy into a fresh ArrayBuffer-backed blob (avoids SharedArrayBuffer typing).
  const blob = new Blob([bytes.slice()], { type });
  return URL.createObjectURL(blob);
}

/** Build our metadata shape from a .sng metadata map (no song.ini file). */
function sngToMetadata(
  map: Map<string, string>,
  fallbackName: string,
): CloneHeroSongMetadata {
  const delay = map.get("delay");
  return {
    name: map.get("name") ?? fallbackName,
    artist: map.get("artist"),
    charter: map.get("charter"),
    year: map.get("year"),
    // .sng `delay` is in milliseconds (added to every note time).
    offsetMs: delay !== undefined ? Math.round(Number(delay)) || 0 : undefined,
  };
}

/** Inspect a Clone Hero `.sng` archive. */
async function inspectSng(file: File): Promise<CloneHeroPackage> {
  const pkg = parseSng(await file.arrayBuffer());
  const entries = Object.fromEntries(pkg.files);
  const findEntry = (name: string) =>
    Object.keys(entries).find((k) => basename(k) === name);

  const metadata = sngToMetadata(pkg.metadata, file.name.replace(/\.[^.]+$/, ""));
  const audio = pickAudioEntry(entries);
  const audioUrl = audio ? audioUrlFrom(audio.bytes, audio.ext) : undefined;

  const chartKey = findEntry("notes.chart");
  const midKey = findEntry("notes.mid");

  if (chartKey) {
    const chartText = new TextDecoder().decode(entries[chartKey]!);
    return {
      fileName: file.name,
      metadata,
      availableDifficulties: listChartDifficulties(chartText),
      format: "chart",
      chartText,
      audioUrl,
    };
  }
  if (midKey) {
    const midiBytes = entries[midKey]!.slice().buffer;
    return {
      fileName: file.name,
      metadata,
      availableDifficulties: listMidiDifficulties(midiBytes),
      format: "midi",
      midiBytes,
      audioUrl,
    };
  }
  throw new Error("That .sng has no notes.chart or notes.mid inside.");
}

/** Inspect a dropped/chosen Clone Hero file without committing to a difficulty. */
export async function inspectCloneHeroFile(file: File): Promise<CloneHeroPackage> {
  const ext = extOf(file.name);

  if (ext === "sng") {
    return inspectSng(file);
  }
  if (ext === "ini") {
    throw new Error(
      "song.ini alone isn't enough — please upload the whole song folder as a .zip.",
    );
  }

  if (ext === "chart") {
    const chartText = await file.text();
    return {
      fileName: file.name,
      metadata: readChartMetadata(chartText),
      availableDifficulties: listChartDifficulties(chartText),
      format: "chart",
      chartText,
    };
  }

  if (ext === "mid" || ext === "midi") {
    const midiBytes = await file.arrayBuffer();
    return {
      fileName: file.name,
      metadata: { name: file.name.replace(/\.[^.]+$/, "") },
      availableDifficulties: listMidiDifficulties(midiBytes),
      format: "midi",
      midiBytes,
    };
  }

  if (ext === "zip") {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const keys = Object.keys(entries);

    const findEntry = (name: string) =>
      keys.find((k) => basename(k) === name);

    const iniKey = findEntry("song.ini");
    const chartKey = findEntry("notes.chart");
    const midKey = findEntry("notes.mid");

    const metadata = iniKey
      ? parseSongIni(strFromU8(entries[iniKey]!))
      : chartKey
        ? readChartMetadata(strFromU8(entries[chartKey]!))
        : { name: file.name.replace(/\.[^.]+$/, "") };

    const audio = pickAudioEntry(entries);
    const audioUrl = audio ? audioUrlFrom(audio.bytes, audio.ext) : undefined;

    if (chartKey) {
      const chartText = strFromU8(entries[chartKey]!);
      return {
        fileName: file.name,
        metadata,
        availableDifficulties: listChartDifficulties(chartText),
        format: "chart",
        chartText,
        audioUrl,
      };
    }
    if (midKey) {
      const midiBytes = entries[midKey]!.slice().buffer;
      return {
        fileName: file.name,
        metadata,
        availableDifficulties: listMidiDifficulties(midiBytes),
        format: "midi",
        midiBytes,
        audioUrl,
      };
    }
    throw new Error("That .zip has no notes.chart or notes.mid inside.");
  }

  throw new Error("Unsupported file. Upload a .zip song folder, .chart, or .mid.");
}

export interface CloneHeroImport {
  chart: RhythmChart;
  audioUrl?: string;
}

/** Build the playable chart for a chosen difficulty from an inspected package. */
export function importCloneHeroPackage(
  pkg: CloneHeroPackage,
  difficulty: Difficulty,
): CloneHeroImport {
  const result = importCloneHeroSong(
    {
      notesChart: pkg.chartText,
      notesMid: pkg.midiBytes,
      audioUrl: pkg.audioUrl,
      // Re-derive song.ini metadata isn't needed; readChartMetadata already ran.
    },
    difficulty,
  );
  // importCloneHeroSong only sees chart/midi here; fold in the inspected metadata.
  result.chart.title = pkg.metadata.name || result.chart.title;
  if (pkg.metadata.artist) result.chart.artist = pkg.metadata.artist;
  if (pkg.metadata.offsetMs !== undefined) {
    result.chart.offsetMs = pkg.metadata.offsetMs;
  }
  return { chart: result.chart, audioUrl: pkg.audioUrl };
}
