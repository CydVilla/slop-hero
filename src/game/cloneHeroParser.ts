/**
 * Clone Hero import.
 *
 * Parses Clone Hero song sources into our internal `RhythmChart`:
 *   - song.ini   → CloneHeroSongMetadata (INI key/value)
 *   - notes.chart→ RhythmChart (.chart text format, tempo-mapped)
 *   - notes.mid  → RhythmChart (minimal Standard MIDI File reader)
 *
 * The 5 colored frets (0–4) map directly onto our 5 lanes. Because the
 * touchscreen MVP is tap-only, sustains are imported as taps (their length is
 * kept on `durationMs` for reference but ignored by scoring), open notes (.chart
 * fret 7) map to a center lane, and modifier flags (forced/HOPO/tap/star power)
 * are dropped. Chords are capped at 2 simultaneous notes to stay finger-playable.
 *
 * Pure & dependency-free (no DOM); ZIP intake / audio object URLs live in
 * `src/lib/cloneHeroClient.ts`. See docs/cloneHeroImportPlan.md.
 */

import { makeNoteId, sortNotes } from "./chartUtils";
import type { ChartNote, Difficulty, Lane, RhythmChart } from "./types";

export interface CloneHeroSongMetadata {
  name: string;
  artist?: string;
  charter?: string;
  year?: string;
  /** Audio offset in milliseconds (added to every note time). */
  offsetMs?: number;
}

/** A single source file pulled out of an imported song folder / ZIP. */
export interface CloneHeroSourceFiles {
  songIni?: string;
  notesChart?: string;
  /** notes.mid bytes, if a MIDI chart is provided instead of .chart. */
  notesMid?: ArrayBuffer;
  /** Object URL or path to the playable audio stem. */
  audioUrl?: string;
}

export interface CloneHeroImportResult {
  metadata: CloneHeroSongMetadata;
  chart: RhythmChart;
  audioUrl?: string;
}

/** Max simultaneous notes kept (touchscreen playability). */
const MAX_CHORD = 2;

/** .chart section names per difficulty (lead/single guitar track). */
const CHART_SECTION: Record<Difficulty, string> = {
  easy: "EasySingle",
  medium: "MediumSingle",
  hard: "HardSingle",
  expert: "ExpertSingle",
};

/** Base MIDI note number for each difficulty's green fret (PART GUITAR). */
const MIDI_BASE: Record<Difficulty, number> = {
  easy: 60,
  medium: 72,
  hard: 84,
  expert: 96,
};

const DIFFICULTY_ORDER: Difficulty[] = ["easy", "medium", "hard", "expert"];

/* ------------------------------- shared utils ----------------------------- */

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse `key = value` lines into a lowercased-key map (values unquoted). */
function parseKeyValues(lines: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = unquote(line.slice(eq + 1));
    if (key) map.set(key, value);
  }
  return map;
}

interface TempoChange {
  tick: number;
  msPerTick: number;
}

/** Build a tick→ms function from sorted tempo changes (a piecewise timeline). */
function makeTickToMs(changes: readonly TempoChange[]): (tick: number) => number {
  const sorted = [...changes].sort((a, b) => a.tick - b.tick);
  if (sorted.length === 0 || (sorted[0]?.tick ?? 0) > 0) {
    // Default 120 BPM segment from tick 0 if none provided at the start.
    sorted.unshift({ tick: 0, msPerTick: sorted[0]?.msPerTick ?? 0 });
  }
  // Precompute cumulative ms at each change boundary.
  const boundaries: { tick: number; ms: number; msPerTick: number }[] = [];
  let ms = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (i === 0) {
      boundaries.push({ tick: cur.tick, ms: 0, msPerTick: cur.msPerTick });
      continue;
    }
    const prev = boundaries[boundaries.length - 1]!;
    ms = prev.ms + (cur.tick - prev.tick) * prev.msPerTick;
    boundaries.push({ tick: cur.tick, ms, msPerTick: cur.msPerTick });
  }

  return (tick: number): number => {
    let lo = 0;
    let hi = boundaries.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid]!.tick <= tick) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const b = boundaries[idx]!;
    return b.ms + (tick - b.tick) * b.msPerTick;
  };
}

interface RawNote {
  tick: number;
  lane: Lane;
  lengthTicks: number;
}

/**
 * Turn raw (tick, lane) notes into a finished chart: tempo-map to ms, sort, and
 * cap chords for touch playability.
 */
function assembleChart(
  rawNotes: readonly RawNote[],
  tickToMs: (tick: number) => number,
  meta: CloneHeroSongMetadata,
  difficulty: Difficulty,
): RhythmChart {
  const notes: ChartNote[] = rawNotes.map((n) => {
    const startMs = tickToMs(n.tick);
    const lengthMs =
      n.lengthTicks > 0 ? Math.round(tickToMs(n.tick + n.lengthTicks) - startMs) : 0;
    const note: ChartNote = {
      id: makeNoteId("ch"),
      timeMs: Math.max(0, Math.round(startMs)),
      lane: n.lane,
      type: "tap",
    };
    if (lengthMs > 0) note.durationMs = lengthMs;
    return note;
  });

  const sorted = sortNotes(notes);
  const capped = capChords(sorted);

  return {
    id: `clonehero_${difficulty}_${Math.round(Math.random() * 1e6).toString(36)}`,
    title: meta.name || "Imported Song",
    artist: meta.artist,
    offsetMs: meta.offsetMs ?? 0,
    difficulty,
    notes: capped,
  };
}

/** Keep at most MAX_CHORD notes that share the same (rounded) time. */
function capChords(sorted: readonly ChartNote[]): ChartNote[] {
  const out: ChartNote[] = [];
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i]!.timeMs;
    let j = i;
    while (j < sorted.length && sorted[j]!.timeMs === t) j++;
    const group = sorted.slice(i, j);
    for (const note of group.slice(0, MAX_CHORD)) out.push(note);
    i = j;
  }
  return out;
}

/* --------------------------------- song.ini ------------------------------- */

/** Parse song.ini contents into metadata. */
export function parseSongIni(contents: string): CloneHeroSongMetadata {
  const lines = contents.split(/\r?\n/).filter((l) => !l.trim().startsWith("["));
  const kv = parseKeyValues(lines);
  const delay = kv.get("delay");
  return {
    name: kv.get("name") ?? "Imported Song",
    artist: kv.get("artist"),
    charter: kv.get("charter") ?? kv.get("frets"),
    year: kv.get("year"),
    // song.ini `delay` is in milliseconds.
    offsetMs: delay !== undefined ? Math.round(Number(delay)) || 0 : undefined,
  };
}

/* -------------------------------- notes.chart ----------------------------- */

/** Split a .chart into `[Section]` → content lines (between the braces). */
function parseChartSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  // Strip a leading UTF-8 BOM (common in .chart files extracted from archives).
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = (lines[i] ?? "").trim().match(/^\[(.+)\]$/);
    if (!header) {
      i++;
      continue;
    }
    const name = header[1]!;
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "{") i++;
    i++; // skip "{"
    const content: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "}") {
      content.push(lines[i] ?? "");
      i++;
    }
    sections.set(name, content);
    i++; // skip "}"
  }
  return sections;
}

/** Read [Song] metadata out of a .chart. */
export function readChartMetadata(contents: string): CloneHeroSongMetadata {
  const sections = parseChartSections(contents);
  const kv = parseKeyValues(sections.get("Song") ?? []);
  const offset = kv.get("offset");
  return {
    name: kv.get("name") ?? "Imported Song",
    artist: kv.get("artist"),
    charter: kv.get("charter"),
    year: kv.get("year"),
    // .chart [Song] Offset is in seconds.
    offsetMs: offset !== undefined ? Math.round((Number(offset) || 0) * 1000) : undefined,
  };
}

function chartResolution(sections: Map<string, string[]>): number {
  const kv = parseKeyValues(sections.get("Song") ?? []);
  const res = Number(kv.get("resolution"));
  return Number.isFinite(res) && res > 0 ? res : 192;
}

function chartTempoChanges(
  sections: Map<string, string[]>,
  resolution: number,
): TempoChange[] {
  const changes: TempoChange[] = [];
  for (const line of sections.get("SyncTrack") ?? []) {
    // `tick = B bpmThousandths`
    const m = line.match(/^\s*(\d+)\s*=\s*B\s+(\d+)/);
    if (!m) continue;
    const tick = Number(m[1]);
    const bpm = Number(m[2]) / 1000;
    if (bpm > 0) {
      changes.push({ tick, msPerTick: 60_000 / bpm / resolution });
    }
  }
  if (changes.length === 0) {
    // No tempo events — assume 120 BPM so timing is at least sane.
    changes.push({ tick: 0, msPerTick: 60_000 / 120 / resolution });
  }
  return changes;
}

/** Which difficulties have a non-empty note section in this .chart. */
export function listChartDifficulties(contents: string): Difficulty[] {
  const sections = parseChartSections(contents);
  return DIFFICULTY_ORDER.filter((d) =>
    (sections.get(CHART_SECTION[d]) ?? []).some((l) => /=\s*N\s+\d+/.test(l)),
  );
}

/** Parse a notes.chart text file into a RhythmChart for one difficulty. */
export function parseNotesChart(
  contents: string,
  difficulty: Difficulty,
): RhythmChart {
  const sections = parseChartSections(contents);
  const resolution = chartResolution(sections);
  const tickToMs = makeTickToMs(chartTempoChanges(sections, resolution));
  const meta = readChartMetadata(contents);

  const sectionLines = sections.get(CHART_SECTION[difficulty]);
  if (!sectionLines) {
    throw new Error(`This chart has no ${difficulty} guitar track.`);
  }

  const raw: RawNote[] = [];
  for (const line of sectionLines) {
    // `tick = N fret length`
    const m = line.match(/^\s*(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/);
    if (!m) continue;
    const tick = Number(m[1]);
    const fret = Number(m[2]);
    const length = Number(m[3]);
    let lane: number | null = null;
    if (fret >= 0 && fret <= 4) lane = fret;
    else if (fret === 7) lane = 2; // open note → center lane
    // fret 5 (forced) / 6 (tap) are modifiers, not notes → skip.
    if (lane === null) continue;
    raw.push({ tick, lane: lane as Lane, lengthTicks: length });
  }

  return assembleChart(raw, tickToMs, meta, difficulty);
}

/* --------------------------------- notes.mid ------------------------------ */

interface MidiTrack {
  name: string;
  /** Note-on events (velocity > 0) with absolute ticks. */
  noteOns: { tick: number; note: number }[];
}

interface ParsedMidi {
  division: number;
  tempo: { tick: number; usPerQuarter: number }[];
  tracks: MidiTrack[];
}

function readMidi(bytes: ArrayBuffer): ParsedMidi {
  const view = new DataView(bytes);
  const ascii = (off: number, len: number): string => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };

  if (ascii(0, 4) !== "MThd") throw new Error("Not a valid MIDI file.");
  const headerLen = view.getUint32(4);
  const rawDivision = view.getUint16(12);
  const division = (rawDivision & 0x8000) === 0 ? rawDivision & 0x7fff : 480;

  let pos = 8 + headerLen;
  const tempo: { tick: number; usPerQuarter: number }[] = [];
  const tracks: MidiTrack[] = [];

  while (pos + 8 <= view.byteLength) {
    const id = ascii(pos, 4);
    const len = view.getUint32(pos + 4);
    let p = pos + 8;
    const end = p + len;
    pos = end;
    if (id !== "MTrk") continue;

    let tick = 0;
    let running = 0;
    let name = "";
    const noteOns: { tick: number; note: number }[] = [];

    const readVarint = (): number => {
      let value = 0;
      for (let n = 0; n < 4; n++) {
        const b = view.getUint8(p++);
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return value;
    };

    while (p < end) {
      tick += readVarint();
      let status = view.getUint8(p);
      if (status & 0x80) {
        p++;
        running = status;
      } else {
        status = running; // running status: reuse previous
      }

      if (status === 0xff) {
        const type = view.getUint8(p++);
        const metaLen = readVarint();
        if (type === 0x51 && metaLen === 3) {
          const us = (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
          tempo.push({ tick, usPerQuarter: us });
        } else if (type === 0x03) {
          name = ascii(p, metaLen);
        }
        p += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        const sysexLen = readVarint();
        p += sysexLen;
      } else {
        const high = status & 0xf0;
        if (high === 0x90) {
          const note = view.getUint8(p++);
          const vel = view.getUint8(p++);
          if (vel > 0) noteOns.push({ tick, note });
        } else if (high === 0x80 || high === 0xa0 || high === 0xb0 || high === 0xe0) {
          p += 2; // two data bytes
        } else if (high === 0xc0 || high === 0xd0) {
          p += 1; // one data byte
        } else {
          p += 1; // unknown — best effort
        }
      }
    }

    tracks.push({ name, noteOns });
  }

  return { division, tempo, tracks };
}

function midiTickToMs(
  tempo: readonly { tick: number; usPerQuarter: number }[],
  division: number,
): (tick: number) => number {
  const changes: TempoChange[] = tempo.map((t) => ({
    tick: t.tick,
    msPerTick: t.usPerQuarter / 1000 / division,
  }));
  if (changes.length === 0) {
    changes.push({ tick: 0, msPerTick: 500_000 / 1000 / division }); // 120 BPM
  }
  return makeTickToMs(changes);
}

/** Pick the guitar track (by name, else the one richest in guitar notes). */
function pickGuitarTrack(tracks: readonly MidiTrack[]): MidiTrack | undefined {
  const named = tracks.find((t) => /GUITAR/i.test(t.name));
  if (named) return named;
  let best: MidiTrack | undefined;
  let bestCount = 0;
  for (const t of tracks) {
    const count = t.noteOns.filter((n) => n.note >= 60 && n.note <= 100).length;
    if (count > bestCount) {
      bestCount = count;
      best = t;
    }
  }
  return bestCount > 0 ? best : undefined;
}

/** Which difficulties have guitar notes in this notes.mid. */
export function listMidiDifficulties(bytes: ArrayBuffer): Difficulty[] {
  const midi = readMidi(bytes);
  const guitar = pickGuitarTrack(midi.tracks);
  if (!guitar) return [];
  return DIFFICULTY_ORDER.filter((d) => {
    const base = MIDI_BASE[d];
    return guitar.noteOns.some((n) => n.note >= base && n.note <= base + 4);
  });
}

/** Parse a notes.mid binary into a RhythmChart for one difficulty. */
export function parseNotesMidi(
  bytes: ArrayBuffer,
  difficulty: Difficulty,
): RhythmChart {
  const midi = readMidi(bytes);
  const guitar = pickGuitarTrack(midi.tracks);
  if (!guitar) throw new Error("No guitar track found in this MIDI file.");

  const tickToMs = midiTickToMs(midi.tempo, midi.division);
  const base = MIDI_BASE[difficulty];
  const raw: RawNote[] = [];
  for (const n of guitar.noteOns) {
    if (n.note < base || n.note > base + 4) continue;
    raw.push({ tick: n.tick, lane: (n.note - base) as Lane, lengthTicks: 0 });
  }
  if (raw.length === 0) {
    throw new Error(`This MIDI has no ${difficulty} guitar notes.`);
  }

  return assembleChart(raw, tickToMs, { name: "Imported Song" }, difficulty);
}

/* ------------------------------- orchestration ---------------------------- */

/**
 * High-level entry point: given the source files from an uploaded folder/ZIP,
 * produce an import result for the chosen difficulty.
 */
export function importCloneHeroSong(
  files: CloneHeroSourceFiles,
  difficulty: Difficulty,
): CloneHeroImportResult {
  const metadata: CloneHeroSongMetadata = files.songIni
    ? parseSongIni(files.songIni)
    : files.notesChart
      ? readChartMetadata(files.notesChart)
      : { name: "Imported Song" };

  let chart: RhythmChart;
  if (files.notesChart) {
    chart = parseNotesChart(files.notesChart, difficulty);
  } else if (files.notesMid) {
    chart = parseNotesMidi(files.notesMid, difficulty);
  } else {
    throw new Error("No notes.chart or notes.mid found to import.");
  }

  // Prefer song.ini metadata for the display title/artist/offset when present.
  chart.title = metadata.name || chart.title;
  if (metadata.artist) chart.artist = metadata.artist;
  if (metadata.offsetMs !== undefined) chart.offsetMs = metadata.offsetMs;

  return { metadata, chart, audioUrl: files.audioUrl };
}
