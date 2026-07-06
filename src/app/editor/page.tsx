"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LANE_COLORS, LANE_COUNT } from "@/game/constants";
import {
  beatsToMs,
  chartDurationMs,
  makeNoteId,
  msToBeats,
  sortNotes,
} from "@/game/chartUtils";
import { getActiveSong, setActiveSong } from "@/lib/activeSong";
import {
  fetchCommunityList,
  publishCommunityChart,
} from "@/lib/community/client";
import {
  blobFromObjectUrl,
  getSong,
  listSongs,
  saveSong,
  type StoredSong,
} from "@/lib/songLibrary";
import type { ChartNote, Difficulty, Lane, RhythmChart } from "@/game/types";

import styles from "./editor.module.css";

/**
 * /editor — the chart editor.
 *
 * Approachability is the whole design: pick a starting point (the song you
 * just played, a saved song, or a blank grid), tap cells on a beat grid to
 * place notes, then test it in the real game, save it to your device library,
 * or publish it to the shared community catalog (notes + optional YouTube id
 * only — audio never leaves the device; see docs/adr/0002).
 *
 * Deliberate v1 limits (docs/adr/0003): tap notes only (existing holds render
 * and can be deleted, not authored), no waveform, no undo stack — the grid
 * itself is the undo (tap again to remove).
 */

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "expert"];
const BEATS_PER_PAGE = 32;
const SNAPS = [
  { label: "1 beat", value: 1 },
  { label: "1/2 beat", value: 0.5 },
  { label: "1/4 beat", value: 0.25 },
] as const;

type SourceKind = "active" | "library" | "blank";

interface EditorSource {
  kind: SourceKind;
  /** Library id when editing a saved song (Save overwrites it). */
  libraryId?: string;
  /** Playable audio for test-play, when the source has any. */
  audioUrl?: string;
  youtubeId?: string;
}

interface LoadedChart {
  source: EditorSource;
  title: string;
  artist: string;
  difficulty: Difficulty;
  bpm: number;
  offsetMs: number;
  notes: ChartNote[];
  durationMs: number;
}

function fromActiveSong(): LoadedChart | null {
  const active = getActiveSong();
  if (!active) return null;
  const chart = active.chart;
  return {
    source: {
      kind: "active",
      audioUrl: active.audioUrl,
      youtubeId: active.youtubeId,
    },
    title: chart.title,
    artist: chart.artist ?? "",
    difficulty: chart.difficulty,
    bpm: chart.bpm && chart.bpm > 0 ? Math.round(chart.bpm) : 120,
    offsetMs: chart.offsetMs,
    notes: sortNotes(chart.notes),
    durationMs: Math.max(chartDurationMs(chart), 8_000),
  };
}

function fromStoredSong(song: StoredSong, audioUrl?: string): LoadedChart {
  return {
    source: {
      kind: "library",
      libraryId: song.id,
      audioUrl,
      youtubeId: song.youtubeId,
    },
    title: song.title,
    artist: song.artist,
    difficulty: song.difficulty,
    bpm: song.bpm > 0 ? Math.round(song.bpm) : 120,
    offsetMs: song.chart.offsetMs,
    notes: sortNotes(song.chart.notes),
    durationMs: Math.max(
      chartDurationMs(song.chart),
      song.durationSeconds * 1000,
      8_000,
    ),
  };
}

function blankChart(bpm: number, lengthSeconds: number): LoadedChart {
  return {
    source: { kind: "blank" },
    title: "My chart",
    artist: "",
    difficulty: "medium",
    bpm,
    offsetMs: 0,
    notes: [],
    durationMs: Math.max(lengthSeconds, 8) * 1000,
  };
}

export default function EditorPage(): React.JSX.Element {
  const router = useRouter();

  const [loaded, setLoaded] = useState<LoadedChart | null>(null);
  const [librarySongs, setLibrarySongs] = useState<StoredSong[]>([]);
  const [libraryPick, setLibraryPick] = useState("");
  const [blankBpm, setBlankBpm] = useState(120);
  const [blankLength, setBlankLength] = useState(60);
  const [hasActive, setHasActive] = useState(false);

  const [snap, setSnap] = useState<number>(0.5);
  const [page, setPage] = useState(0);

  const [contributor, setContributor] = useState("");
  const [communityConfigured, setCommunityConfigured] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [publishState, setPublishState] = useState<
    "idle" | "publishing" | "published"
  >("idle");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  // Object URLs created here (library audio) — revoke on replacement/unmount.
  const ownedUrlRef = useRef<string | null>(null);
  const setOwnedUrl = useCallback((url: string | null) => {
    if (ownedUrlRef.current) URL.revokeObjectURL(ownedUrlRef.current);
    ownedUrlRef.current = url;
  }, []);
  useEffect(() => () => setOwnedUrl(null), [setOwnedUrl]);

  useEffect(() => {
    // Start from the song the player just had open, when there is one.
    const active = fromActiveSong();
    setHasActive(active !== null);
    if (active) setLoaded(active);

    void listSongs().then(setLibrarySongs);
    void fetchCommunityList().then((l) => setCommunityConfigured(l.configured));
  }, []);

  const resetFlags = useCallback(() => {
    setSaveState("idle");
    setPublishState("idle");
    setPublishError(null);
    setPage(0);
  }, []);

  const loadActive = useCallback(() => {
    const active = fromActiveSong();
    if (!active) return;
    setOwnedUrl(null);
    setLoaded(active);
    resetFlags();
  }, [resetFlags, setOwnedUrl]);

  const loadLibrary = useCallback(
    async (id: string) => {
      const song = await getSong(id);
      if (!song) return;
      const url = song.audio ? URL.createObjectURL(song.audio) : undefined;
      setOwnedUrl(url ?? null);
      setLoaded(fromStoredSong(song, url));
      resetFlags();
    },
    [resetFlags, setOwnedUrl],
  );

  const loadBlank = useCallback(() => {
    setOwnedUrl(null);
    setLoaded(blankChart(blankBpm, blankLength));
    resetFlags();
  }, [blankBpm, blankLength, resetFlags, setOwnedUrl]);

  // ---- Grid model -------------------------------------------------------

  const totalBeats = useMemo(() => {
    if (!loaded) return 0;
    const beats = Math.max(
      msToBeats(loaded.durationMs, loaded.bpm),
      msToBeats(chartDurationMs(currentChart(loaded)), loaded.bpm),
    );
    return Math.max(BEATS_PER_PAGE, Math.ceil(beats / 4) * 4);
  }, [loaded]);

  const pageCount = Math.max(1, Math.ceil(totalBeats / BEATS_PER_PAGE));
  const clampedPage = Math.min(page, pageCount - 1);

  const rows = useMemo(() => {
    if (!loaded) return [];
    const startBeat = clampedPage * BEATS_PER_PAGE;
    const endBeat = Math.min(totalBeats, startBeat + BEATS_PER_PAGE);
    const out: { beat: number; timeMs: number }[] = [];
    for (let b = startBeat; b < endBeat; b += snap) {
      out.push({ beat: b, timeMs: beatsToMs(b, loaded.bpm) });
    }
    return out;
  }, [loaded, clampedPage, snap, totalBeats]);

  /** Notes indexed by "slot:lane" for the current snap/bpm. */
  const occupancy = useMemo(() => {
    const map = new Map<string, ChartNote[]>();
    if (!loaded) return map;
    for (const note of loaded.notes) {
      const slot = Math.round(msToBeats(note.timeMs, loaded.bpm) / snap);
      const key = `${slot}:${note.lane}`;
      const list = map.get(key);
      if (list) list.push(note);
      else map.set(key, [note]);
    }
    return map;
  }, [loaded, snap]);

  const toggleCell = useCallback(
    (beat: number, lane: Lane) => {
      setLoaded((prev) => {
        if (!prev) return prev;
        const slot = Math.round(beat / snap);
        const existing = prev.notes.filter((n) => {
          const s = Math.round(msToBeats(n.timeMs, prev.bpm) / snap);
          return s === slot && n.lane === lane;
        });
        let notes: ChartNote[];
        if (existing.length > 0) {
          const ids = new Set(existing.map((n) => n.id));
          notes = prev.notes.filter((n) => !ids.has(n.id));
        } else {
          notes = sortNotes([
            ...prev.notes,
            {
              id: makeNoteId("ed"),
              timeMs: beatsToMs(beat, prev.bpm),
              lane,
              type: "tap",
            },
          ]);
        }
        return { ...prev, notes };
      });
      setSaveState("idle");
      setPublishState("idle");
    },
    [snap],
  );

  const extend = useCallback(() => {
    setLoaded((prev) =>
      prev
        ? {
            ...prev,
            durationMs: prev.durationMs + beatsToMs(BEATS_PER_PAGE, prev.bpm),
          }
        : prev,
    );
  }, []);

  const update = useCallback(<K extends keyof LoadedChart>(key: K, value: LoadedChart[K]) => {
    setLoaded((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveState("idle");
    setPublishState("idle");
  }, []);

  // ---- Actions ----------------------------------------------------------

  const testPlay = useCallback(() => {
    if (!loaded) return;
    const chart = currentChart(loaded);
    setActiveSong({
      chart,
      audioUrl: loaded.source.audioUrl,
      youtubeId: loaded.source.youtubeId,
      title: loaded.title,
      subtitle: "Editor preview",
      meta: {
        trackId: loaded.source.libraryId ?? "editor-preview",
        source: loaded.source.youtubeId ? "youtube" : "session",
        difficulty: loaded.difficulty,
        bpm: loaded.bpm,
        artist: loaded.artist || undefined,
      },
    });
    router.push("/play");
  }, [loaded, router]);

  const saveToLibrary = useCallback(async () => {
    if (!loaded) return;
    setSaveState("saving");
    try {
      const id = loaded.source.libraryId ?? `song-${Date.now()}`;
      // Carry the audio blob along: reuse the stored one when editing a saved
      // song, otherwise recover it from the session's object URL.
      let audio: Blob | undefined;
      if (loaded.source.libraryId) {
        audio = (await getSong(loaded.source.libraryId))?.audio;
      } else if (loaded.source.audioUrl) {
        audio = await blobFromObjectUrl(loaded.source.audioUrl).catch(
          () => undefined,
        );
      }
      const song: StoredSong = {
        id,
        title: loaded.title.trim() || "My chart",
        artist: loaded.artist.trim() || "Custom chart",
        contributor: contributor.trim() || "You",
        difficulty: loaded.difficulty,
        bpm: loaded.bpm,
        durationSeconds: Math.max(1, Math.round(loaded.durationMs / 1000)),
        addedAt: new Date().toISOString().slice(0, 10),
        savedAt: Date.now(),
        youtubeId: loaded.source.youtubeId,
        audio,
        chart: currentChart(loaded, id),
      };
      const ok = await saveSong(song);
      if (ok) {
        setLoaded((prev) =>
          prev
            ? { ...prev, source: { ...prev.source, kind: "library", libraryId: id } }
            : prev,
        );
        void listSongs().then(setLibrarySongs);
      }
      setSaveState(ok ? "saved" : "idle");
    } catch {
      setSaveState("idle");
    }
  }, [loaded, contributor]);

  const publish = useCallback(async () => {
    if (!loaded) return;
    setPublishState("publishing");
    setPublishError(null);
    try {
      await publishCommunityChart({
        title: loaded.title.trim() || "My chart",
        artist: loaded.artist.trim() || undefined,
        contributor: contributor.trim() || "Anonymous",
        difficulty: loaded.difficulty,
        bpm: loaded.bpm,
        durationSeconds: Math.max(1, Math.round(loaded.durationMs / 1000)),
        youtubeId: loaded.source.youtubeId,
        chart: currentChart(loaded),
      });
      setPublishState("published");
    } catch (e) {
      setPublishState("idle");
      setPublishError(e instanceof Error ? e.message : "Publishing failed.");
    }
  }, [loaded, contributor]);

  // ---- Render -----------------------------------------------------------

  const noteCount = loaded?.notes.length ?? 0;
  const json = useMemo(
    () => (loaded && showJson ? JSON.stringify(currentChart(loaded), null, 2) : ""),
    [loaded, showJson],
  );

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          ‹ Home
        </Link>
      </header>

      <h1 className={styles.title}>Chart editor</h1>
      <p className={styles.lede}>
        <strong>1.</strong> Pick a starting point · <strong>2.</strong> Tap grid
        cells to place notes · <strong>3.</strong> Test it, save it to this
        device, or publish it for everyone.
      </p>

      <section className={styles.startRow}>
        <div className={styles.startCard}>
          <h2 className={styles.h2}>Current song</h2>
          <p className={styles.hint}>
            {hasActive
              ? "Edit the chart of the song you just had open."
              : "Play or add a song first and it appears here."}
          </p>
          <button
            type="button"
            className={styles.secondaryBtn}
            disabled={!hasActive}
            onClick={loadActive}
          >
            Load current song
          </button>
        </div>

        <div className={styles.startCard}>
          <h2 className={styles.h2}>From your library</h2>
          <p className={styles.hint}>
            {librarySongs.length > 0
              ? "Songs saved on this device."
              : "Songs you add on the Upload page are saved here."}
          </p>
          <div className={styles.pickRow}>
            <select
              className={styles.select}
              value={libraryPick}
              onChange={(e) => setLibraryPick(e.target.value)}
              disabled={librarySongs.length === 0}
            >
              <option value="">Choose a song…</option>
              {librarySongs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.difficulty})
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={!libraryPick}
              onClick={() => void loadLibrary(libraryPick)}
            >
              Load
            </button>
          </div>
        </div>

        <div className={styles.startCard}>
          <h2 className={styles.h2}>Blank chart</h2>
          <p className={styles.hint}>Start from an empty grid (silent play).</p>
          <div className={styles.pickRow}>
            <label className={styles.inlineField}>
              BPM
              <input
                type="number"
                className={styles.numInput}
                min={40}
                max={300}
                value={blankBpm}
                onChange={(e) =>
                  setBlankBpm(Math.max(40, Math.min(300, Number(e.target.value) || 120)))
                }
              />
            </label>
            <label className={styles.inlineField}>
              Length (s)
              <input
                type="number"
                className={styles.numInput}
                min={8}
                max={900}
                value={blankLength}
                onChange={(e) =>
                  setBlankLength(Math.max(8, Math.min(900, Number(e.target.value) || 60)))
                }
              />
            </label>
            <button type="button" className={styles.secondaryBtn} onClick={loadBlank}>
              Create
            </button>
          </div>
        </div>
      </section>

      {loaded && (
        <>
          <section className={styles.metaRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Title</span>
              <input
                type="text"
                className={styles.textInput}
                maxLength={80}
                value={loaded.title}
                onChange={(e) => update("title", e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Artist</span>
              <input
                type="text"
                className={styles.textInput}
                maxLength={80}
                placeholder="optional"
                value={loaded.artist}
                onChange={(e) => update("artist", e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>BPM (grid)</span>
              <input
                type="number"
                className={styles.numInput}
                min={40}
                max={300}
                value={loaded.bpm}
                onChange={(e) =>
                  update("bpm", Math.max(40, Math.min(300, Number(e.target.value) || 120)))
                }
              />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Difficulty</span>
              <div className={styles.chips}>
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`${styles.chip} ${loaded.difficulty === d ? styles.chipActive : ""}`}
                    onClick={() => update("difficulty", d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className={styles.gridPanel}>
            <div className={styles.gridToolbar}>
              <div className={styles.chips}>
                {SNAPS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={`${styles.chip} ${snap === s.value ? styles.chipActive : ""}`}
                    onClick={() => setSnap(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className={styles.pager}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={clampedPage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Earlier
                </button>
                <span className={styles.pageLabel}>
                  Beats {clampedPage * BEATS_PER_PAGE}–
                  {Math.min(totalBeats, (clampedPage + 1) * BEATS_PER_PAGE)} ·{" "}
                  {noteCount} notes
                </span>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={clampedPage >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                >
                  Later ›
                </button>
                {clampedPage >= pageCount - 1 && (
                  <button type="button" className={styles.secondaryBtn} onClick={extend}>
                    + Add {BEATS_PER_PAGE} beats
                  </button>
                )}
              </div>
            </div>

            <p className={styles.hint}>
              Tap a cell to place a note; tap again to remove it. Downbeats are
              brighter. Changing BPM moves the grid, not the notes you already
              placed.
            </p>

            <div className={styles.gridScroll}>
              <div className={styles.gridHead}>
                <span className={styles.beatCol}>beat</span>
                {Array.from({ length: LANE_COUNT }, (_, lane) => (
                  <span
                    key={lane}
                    className={styles.laneHead}
                    style={{ color: LANE_COLORS[lane as Lane] }}
                  >
                    {lane + 1}
                  </span>
                ))}
              </div>
              {rows.map(({ beat, timeMs }) => {
                const downbeat = beat % 4 === 0;
                const wholeBeat = Number.isInteger(beat);
                return (
                  <div
                    key={beat}
                    className={`${styles.gridRow} ${downbeat ? styles.downbeat : ""}`}
                  >
                    <span className={styles.beatCol}>
                      {wholeBeat ? beat : ""}
                      {downbeat && (
                        <em className={styles.timeLabel}>
                          {(timeMs / 1000).toFixed(1)}s
                        </em>
                      )}
                    </span>
                    {Array.from({ length: LANE_COUNT }, (_, laneIdx) => {
                      const lane = laneIdx as Lane;
                      const slot = Math.round(beat / snap);
                      const cellNotes = occupancy.get(`${slot}:${lane}`) ?? [];
                      const hasNote = cellNotes.length > 0;
                      const isHold = cellNotes.some(
                        (n) => (n.durationMs ?? 0) > 0,
                      );
                      return (
                        <button
                          key={lane}
                          type="button"
                          className={`${styles.cell} ${hasNote ? styles.cellOn : ""}`}
                          style={
                            hasNote
                              ? ({ "--lane": LANE_COLORS[lane] } as React.CSSProperties)
                              : undefined
                          }
                          aria-label={`Beat ${beat}, lane ${lane + 1}${hasNote ? " — has note" : ""}`}
                          onClick={() => toggleCell(beat, lane)}
                        >
                          {hasNote ? (isHold ? "▮" : "●") : ""}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>

          <section className={styles.actions}>
            <label className={`${styles.field} ${styles.contribField}`}>
              <span className={styles.fieldLabel}>Your name (for credits)</span>
              <input
                type="text"
                className={styles.textInput}
                placeholder="You"
                maxLength={40}
                value={contributor}
                onChange={(e) => setContributor(e.target.value)}
              />
            </label>

            <div className={styles.actionBtns}>
              <button type="button" className={styles.primaryBtn} onClick={testPlay}>
                ▶ Test play
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={saveState === "saving"}
                onClick={() => void saveToLibrary()}
              >
                {saveState === "saved"
                  ? "Saved ✓"
                  : saveState === "saving"
                    ? "Saving…"
                    : "Save to this device"}
              </button>
              {communityConfigured && (
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={publishState !== "idle" || noteCount < 4}
                  onClick={() => void publish()}
                >
                  {publishState === "published"
                    ? "Published ✓"
                    : publishState === "publishing"
                      ? "Publishing…"
                      : "Publish to shared catalog"}
                </button>
              )}
            </div>

            {publishError && <p className={styles.error}>{publishError}</p>}
            {publishState === "published" && (
              <p className={styles.hint}>
                It&apos;s live — everyone can see it in the{" "}
                <Link href="/catalog" className={styles.inlineLink}>
                  catalog
                </Link>
                &apos;s community section.
              </p>
            )}
            {communityConfigured && (
              <p className={styles.hint}>
                Publishing shares your <strong>notes and timing</strong>
                {loaded.source.youtubeId
                  ? " plus the YouTube link"
                  : ""} — never audio files.
                {!loaded.source.youtubeId && loaded.source.audioUrl
                  ? " This chart uses an uploaded audio file, which stays on your device; others will play it in silent mode."
                  : ""}
              </p>
            )}

            <button
              type="button"
              className={styles.jsonToggle}
              onClick={() => setShowJson((v) => !v)}
            >
              {showJson ? "Hide chart JSON" : "Show chart JSON"}
            </button>
            {showJson && (
              <textarea className={styles.json} readOnly value={json} spellCheck={false} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** Assemble the RhythmChart from the current editor state. */
function currentChart(loaded: LoadedChart, id = "editor"): RhythmChart {
  return {
    id,
    title: loaded.title.trim() || "My chart",
    artist: loaded.artist.trim() || undefined,
    bpm: loaded.bpm,
    offsetMs: loaded.offsetMs,
    difficulty: loaded.difficulty,
    notes: loaded.notes,
  };
}
