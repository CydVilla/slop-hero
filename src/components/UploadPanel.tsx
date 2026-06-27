"use client";

/**
 * UploadPanel
 *
 * Handles user audio upload entirely in the browser (no server):
 *   - reads file metadata,
 *   - probes duration via a hidden <audio> element,
 *   - lets the user pick a chart source (auto-analyze the audio, or a simple BPM
 *     grid), difficulty + BPM, and credit a contributor,
 *   - generates the chart and hands it back via onReady.
 *
 * "Auto-analyze" decodes the audio and runs real onset/tempo detection in a Web
 * Worker (src/lib/analyzeClient.ts → src/workers/analyzeWorker.ts). If analysis
 * fails or finds too few onsets, it transparently falls back to the deterministic
 * BPM-grid automapper.
 *
 * If a non-audio file is provided (notably a Clone Hero chart/folder), we do NOT
 * silently ignore it — we show an explanatory notice, because Clone Hero import
 * is planned but not implemented yet (see docs/cloneHeroImportPlan.md).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { generateAutoChart } from "@/game/autoMapper";
import type { Difficulty, RhythmChart } from "@/game/types";
import { analyzeFileToChart } from "@/lib/analyzeClient";
import {
  importCloneHeroPackage,
  inspectCloneHeroFile,
  inspectCloneHeroFolder,
  type CloneHeroPackage,
  type NamedFile,
} from "@/lib/cloneHeroClient";
import { parseLengthSeconds, parseYouTubeId } from "@/lib/youtube";

import styles from "./UploadPanel.module.css";

export interface UploadResult {
  /** Playable audio. Undefined => silent/demo mode (e.g. a chart with no audio). */
  audioUrl?: string;
  /** YouTube video id when the source is an embedded YouTube video. */
  youtubeId?: string;
  chart: RhythmChart;
  fileName: string;
  contributor: string;
}

interface UploadPanelProps {
  onReady: (result: UploadResult) => void;
  /**
   * Restrict to the YouTube-link source only (no local file/folder pickers).
   * Used on the Tesla browser, which can't open local files but can embed
   * YouTube.
   */
  youtubeOnly?: boolean;
}

type UploadMode = "file" | "youtube";

/** One YouTube search result, as returned by /api/youtube/search. */
interface YouTubeSearchItem {
  id: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  durationSeconds: number;
  durationLabel: string;
}

/**
 * YouTube API titles arrive HTML-escaped (e.g. "Rock &amp; Roll"). Decode them
 * for display. Runs only in the browser; falls back to the raw text on the
 * server (this is a client component, so that path is just a safety net).
 */
function decodeEntities(text: string): string {
  if (typeof document === "undefined") return text;
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

/** Format seconds as an "m:ss" string that parseLengthSeconds() accepts. */
function lengthFieldFromSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "3:00";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface FileMeta {
  name: string;
  size: number;
  type: string;
  durationSeconds: number | null;
}

type ChartSource = "analyze" | "grid";

// `webkitdirectory`/`directory` aren't in React's typed input props, but they
// must be present at first render (not added later in an effect) so the native
// picker opens in folder-selection mode reliably across browsers.
const DIRECTORY_ATTRS = {
  webkitdirectory: "",
  directory: "",
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard", "expert"];

/** Extensions routed to the Clone Hero importer. */
const CLONE_HERO_EXT = ["chart", "mid", "midi", "ini", "zip", "sng"];

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isCloneHeroFile(name: string): boolean {
  return CLONE_HERO_EXT.includes(extOf(name)) || name.toLowerCase() === "song.ini";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Recursively collect files (with their full path) from a dropped entry. */
async function walkEntry(entry: FileSystemEntry, out: NamedFile[]): Promise<void> {
  if (entry.isFile) {
    try {
      const file = await readEntryFile(entry as FileSystemFileEntry);
      out.push({ path: entry.fullPath, file });
    } catch {
      /* skip unreadable file */
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries yields in batches; keep reading until it returns empty.
    for (;;) {
      let batch: FileSystemEntry[];
      try {
        batch = await readDirEntries(reader);
      } catch {
        break;
      }
      if (batch.length === 0) break;
      for (const e of batch) await walkEntry(e, out);
    }
  }
}

/**
 * If a folder was dropped, expand it into a flat list of files.
 * Returns null when no directory is present (so the single-file path handles it).
 * Note: webkitGetAsEntry() must be read synchronously before any await.
 */
async function folderFilesFromDrop(dt: DataTransfer): Promise<NamedFile[] | null> {
  const items = dt.items;
  if (!items || items.length === 0) return null;
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i]?.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.some((e) => e.isDirectory)) return null;
  const out: NamedFile[] = [];
  for (const e of entries) await walkEntry(e, out);
  return out;
}

export function UploadPanel({ onReady, youtubeOnly = false }: UploadPanelProps): React.JSX.Element {
  const [mode, setMode] = useState<UploadMode>(youtubeOnly ? "youtube" : "file");
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [bpm, setBpm] = useState(120);
  const [contributor, setContributor] = useState("");
  const [source, setSource] = useState<ChartSource>("analyze");
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [info, setInfo] = useState<string | null>(null);

  // YouTube-link source.
  const [ytUrl, setYtUrl] = useState("");
  const [ytTitle, setYtTitle] = useState("");
  const [ytLength, setYtLength] = useState("3:00");

  // In-app YouTube search (optional; needs YOUTUBE_API_KEY on the server).
  const [ytQuery, setYtQuery] = useState("");
  const [ytResults, setYtResults] = useState<YouTubeSearchItem[]>([]);
  const [ytSearching, setYtSearching] = useState(false);
  const [ytSearchError, setYtSearchError] = useState<string | null>(null);
  const [ytSearchConfigured, setYtSearchConfigured] = useState<boolean | null>(null);
  const [ytSelectedId, setYtSelectedId] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);

  // Clone Hero import state.
  const [chPkg, setChPkg] = useState<CloneHeroPackage | null>(null);
  const [chDifficulty, setChDifficulty] = useState<Difficulty>("expert");
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const previousUrlRef = useRef<string | null>(null);
  const fileRef = useRef<File | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const resetForNewFile = useCallback(() => {
    setError(null);
    setInfo(null);
    setChPkg(null);
    setMeta(null);
    setAudioUrl(null);
  }, []);

  const handleAudioFile = useCallback((file: File) => {
    fileRef.current = file;
    if (previousUrlRef.current) URL.revokeObjectURL(previousUrlRef.current);
    const url = URL.createObjectURL(file);
    previousUrlRef.current = url;
    setAudioUrl(url);
    setMeta({
      name: file.name,
      size: file.size,
      type: file.type || "unknown",
      durationSeconds: null,
    });

    const probe = document.createElement("audio");
    probe.preload = "metadata";
    probe.src = url;
    probe.addEventListener("loadedmetadata", () => {
      const dur = Number.isFinite(probe.duration) ? probe.duration : null;
      setMeta((m) => (m ? { ...m, durationSeconds: dur } : m));
    });
  }, []);

  const handleCloneHeroFile = useCallback(async (file: File) => {
    setInspecting(true);
    try {
      const pkg = await inspectCloneHeroFile(file);
      if (pkg.availableDifficulties.length === 0) {
        setError("Couldn't find a playable guitar track in that file.");
        return;
      }
      setChPkg(pkg);
      const last = pkg.availableDifficulties[pkg.availableDifficulties.length - 1]!;
      setChDifficulty(
        pkg.availableDifficulties.includes("expert") ? "expert" : last,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file.");
    } finally {
      setInspecting(false);
    }
  }, []);

  const handleCloneHeroFolder = useCallback(
    async (files: NamedFile[]) => {
      resetForNewFile();
      setInspecting(true);
      try {
        const pkg = await inspectCloneHeroFolder(files);
        if (pkg.availableDifficulties.length === 0) {
          setError("Couldn't find a playable guitar track in that folder.");
          return;
        }
        setChPkg(pkg);
        const last = pkg.availableDifficulties[pkg.availableDifficulties.length - 1]!;
        setChDifficulty(
          pkg.availableDifficulties.includes("expert") ? "expert" : last,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't read that folder.");
      } finally {
        setInspecting(false);
      }
    },
    [resetForNewFile],
  );

  const handleFile = useCallback(
    (file: File) => {
      resetForNewFile();
      if (file.type.startsWith("audio")) {
        handleAudioFile(file);
      } else if (isCloneHeroFile(file.name)) {
        void handleCloneHeroFile(file);
      } else {
        setError("That doesn't look like audio or a Clone Hero song.");
      }
    },
    [resetForNewFile, handleAudioFile, handleCloneHeroFile],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const onDirInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list || list.length === 0) return;
      const files: NamedFile[] = Array.from(list).map((f) => ({
        path: f.webkitRelativePath || f.name,
        file: f,
      }));
      void handleCloneHeroFolder(files);
      // Allow re-selecting the same folder later.
      e.target.value = "";
    },
    [handleCloneHeroFolder],
  );

  const handleDataTransfer = useCallback(
    (dt: DataTransfer) => {
      // Snapshot what we need synchronously — DataTransfer is only valid during
      // the event, and webkitGetAsEntry() must be read before any await.
      const firstFile = dt.files?.[0] ?? null;
      void folderFilesFromDrop(dt).then((folderFiles) => {
        if (folderFiles) {
          if (folderFiles.length === 0) {
            setError("That folder was empty.");
            return;
          }
          void handleCloneHeroFolder(folderFiles);
          return;
        }
        if (firstFile) handleFile(firstFile);
      });
    },
    [handleFile, handleCloneHeroFolder],
  );

  // Make the whole page a drop target. Dropping a file/folder anywhere on the
  // upload screen works (and the browser won't try to open it), which is far
  // more forgiving than aiming for the dashed box. Disabled in YouTube mode.
  useEffect(() => {
    if (mode !== "file") return;
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // relatedTarget is null when the cursor leaves the window entirely.
      if (e.relatedTarget === null) setDragActive(false);
    };
    const onWindowDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      setDragActive(false);
      handleDataTransfer(e.dataTransfer);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, [mode, handleDataTransfer]);

  const handleYouTube = useCallback(() => {
    setError(null);
    setInfo(null);
    const id = parseYouTubeId(ytUrl);
    if (!id) {
      setError("That doesn't look like a YouTube link.");
      return;
    }
    const durationSeconds = parseLengthSeconds(ytLength) ?? 180;
    const title = ytTitle.trim() || "YouTube track";
    const chart = generateAutoChart({
      durationSeconds,
      difficulty,
      bpm,
      title,
      artist: "YouTube",
    });
    onReady({
      youtubeId: id,
      chart,
      fileName: title,
      contributor: contributor.trim() || "You",
    });
  }, [ytUrl, ytLength, ytTitle, difficulty, bpm, contributor, onReady]);

  // Debounced YouTube search. Calls our server proxy (which holds the API key)
  // and degrades gracefully when search isn't configured by revealing the
  // paste-a-link field instead.
  useEffect(() => {
    if (mode !== "youtube") return;
    const q = ytQuery.trim();
    if (q.length < 2) {
      setYtResults([]);
      setYtSearching(false);
      setYtSearchError(null);
      return;
    }
    let cancelled = false;
    setYtSearching(true);
    const handle = setTimeout(() => {
      fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`)
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (cancelled) return;
          const configured = data.configured ?? false;
          setYtSearchConfigured(configured);
          if (!configured) {
            setShowPaste(true);
            setYtResults([]);
            setYtSearchError(null);
          } else if (!res.ok) {
            setYtResults([]);
            setYtSearchError(data.error ?? "Search failed — try pasting a link.");
          } else {
            setYtResults(data.items ?? []);
            setYtSearchError(null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setYtResults([]);
            setYtSearchError("Search failed — check your connection or paste a link.");
          }
        })
        .finally(() => {
          if (!cancelled) setYtSearching(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [ytQuery, mode]);

  const handleSelectResult = useCallback((item: YouTubeSearchItem) => {
    setYtSelectedId(item.id);
    // parseYouTubeId() accepts a bare 11-char id, so we can reuse handleYouTube.
    setYtUrl(item.id);
    setYtTitle(decodeEntities(item.title));
    if (item.durationSeconds > 0) {
      setYtLength(lengthFieldFromSeconds(item.durationSeconds));
    }
    setError(null);
    // Collapse the results menu now that a pick has been made. Clearing the
    // query also stops the debounced search from immediately re-opening it; the
    // chosen track stays reflected in the Title field below.
    setYtQuery("");
    setYtResults([]);
    setYtSearchError(null);
    setYtSearching(false);
  }, []);

  const canGenerate = audioUrl !== null && meta !== null && !analyzing;

  const handleGenerate = useCallback(async () => {
    if (!audioUrl || !meta) return;
    const durationSeconds = meta.durationSeconds ?? 120;
    const baseTitle = meta.name.replace(/\.[^.]+$/, "");
    const finish = (chart: RhythmChart) =>
      onReady({
        audioUrl,
        chart,
        fileName: meta.name,
        contributor: contributor.trim() || "You",
      });

    if (source === "analyze" && fileRef.current) {
      setAnalyzing(true);
      setProgress(0);
      setInfo(null);
      try {
        const chart = await analyzeFileToChart(fileRef.current, {
          difficulty,
          bpmHint: bpm,
          title: baseTitle,
          artist: "Your upload",
          onProgress: setProgress,
        });
        finish(chart);
        return;
      } catch {
        setInfo("Couldn't analyze that audio — used a BPM grid instead.");
      } finally {
        setAnalyzing(false);
      }
    }

    finish(
      generateAutoChart({
        durationSeconds,
        difficulty,
        bpm,
        title: baseTitle,
        artist: "Your upload",
      }),
    );
  }, [audioUrl, meta, source, difficulty, bpm, contributor, onReady]);

  const handleImport = useCallback(async () => {
    if (!chPkg) return;
    setImporting(true);
    setInfo(null);
    try {
      const { chart, audioUrl: chAudio } = importCloneHeroPackage(chPkg, chDifficulty);
      onReady({
        audioUrl: chAudio,
        chart,
        fileName: chPkg.fileName,
        contributor: contributor.trim() || "You",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }, [chPkg, chDifficulty, contributor, onReady]);

  const generateLabel = analyzing
    ? `Analyzing… ${Math.round(progress * 100)}%`
    : source === "analyze"
      ? "Analyze & play"
      : "Generate chart & play";

  const nameField = (
    <div className={`${styles.field} ${styles.grow}`}>
      <span className={styles.fieldLabel}>Your name (for the catalog)</span>
      <input
        type="text"
        className={styles.textInput}
        placeholder="You"
        maxLength={40}
        value={contributor}
        onChange={(e) => setContributor(e.target.value)}
      />
    </div>
  );

  return (
    <div className={styles.panel}>
      {!youtubeOnly && (
        <div className={styles.segmented}>
          <button
            type="button"
            className={`${styles.segBtn} ${mode === "file" ? styles.segActive : ""}`}
            onClick={() => setMode("file")}
          >
            Upload file
          </button>
          <button
            type="button"
            className={`${styles.segBtn} ${mode === "youtube" ? styles.segActive : ""}`}
            onClick={() => setMode("youtube")}
          >
            YouTube link
          </button>
        </div>
      )}

      {mode === "file" && (
        <>
      {dragActive && (
        <div className={styles.dragOverlay}>
          <div className={styles.dragOverlayInner}>
            <span className={styles.dragOverlayTitle}>Drop to load</span>
            <span className={styles.dragOverlayHint}>
              audio, a Clone Hero song (.sng / .zip / .chart / .mid), or a song
              folder — drop anywhere
            </span>
          </div>
        </div>
      )}

      <label className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ""}`}>
        <input
          type="file"
          accept="audio/*,.zip,.chart,.mid,.midi,.sng,.ini"
          className={styles.hiddenInput}
          onChange={onInputChange}
        />
        <span className={styles.dropTitle}>Tap to choose a file</span>
        <span className={styles.dropHint}>
          audio (mp3, wav, ogg, m4a) or a single Clone Hero file (.sng / .zip /
          .chart / .mid)
        </span>
      </label>

      <div className={styles.folderRow}>
        <input
          ref={dirInputRef}
          type="file"
          {...DIRECTORY_ATTRS}
          className={styles.hiddenInput}
          onChange={onDirInputChange}
        />
        <span className={styles.folderHint}>
          Got an <strong>unzipped</strong>{" "}
          Clone Hero folder? Use this button (the file picker above can&apos;t
          select folders) —
        </span>
        <button
          type="button"
          className={styles.folderBtn}
          onClick={() => dirInputRef.current?.click()}
        >
          Choose folder
        </button>
      </div>

      <p className={styles.dropAny}>
        …or just drag &amp; drop a file <strong>or a folder</strong> anywhere on
        this page.
      </p>
        </>
      )}

      {mode === "youtube" && (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Search for a song</span>
            <input
              type="search"
              inputMode="search"
              className={styles.textInput}
              placeholder="Search YouTube — song or artist…"
              value={ytQuery}
              onChange={(e) => setYtQuery(e.target.value)}
            />
          </div>

          {ytSearching && (
            <div className={styles.searchStatus}>Searching…</div>
          )}

          {ytSearchConfigured === false && ytQuery.trim().length >= 2 && (
            <div className={styles.info}>
              In-app search isn&apos;t available right now — paste a YouTube link
              below instead.
            </div>
          )}

          {ytSearchError && <div className={styles.info}>{ytSearchError}</div>}

          {ytSelectedId && ytResults.length === 0 && !ytSearching && (
            <div className={styles.searchStatus}>
              Selected ✓ — adjust the details below, or search again to change it.
            </div>
          )}

          {ytResults.length > 0 && (
            <ul className={styles.results}>
              {ytResults.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`${styles.resultBtn} ${ytSelectedId === item.id ? styles.resultActive : ""}`}
                    onClick={() => handleSelectResult(item)}
                  >
                    {item.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className={styles.resultThumb}
                        src={item.thumbnail}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.resultThumb} aria-hidden />
                    )}
                    <span className={styles.resultInfo}>
                      <span className={styles.resultTitle}>
                        {decodeEntities(item.title)}
                      </span>
                      <span className={styles.resultMeta}>
                        {decodeEntities(item.channelTitle)}
                        {item.durationLabel !== "—"
                          ? ` · ${item.durationLabel}`
                          : ""}
                      </span>
                    </span>
                    {ytSelectedId === item.id && (
                      <span className={styles.resultCheck} aria-hidden>
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className={styles.linkToggle}
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? "Hide link field" : "Or paste a YouTube link instead"}
          </button>

          {(showPaste || ytSearchConfigured === false) && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>YouTube link</span>
              <input
                type="url"
                inputMode="url"
                className={styles.textInput}
                placeholder="https://www.youtube.com/watch?v=…"
                value={ytUrl}
                onChange={(e) => {
                  setYtUrl(e.target.value);
                  setYtSelectedId(null);
                }}
              />
            </div>
          )}

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Title (for the catalog)</span>
            <input
              type="text"
              className={styles.textInput}
              placeholder="YouTube track"
              maxLength={80}
              value={ytTitle}
              onChange={(e) => setYtTitle(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Difficulty</span>
            <div className={styles.difficulties}>
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`${styles.diffBtn} ${difficulty === d ? styles.diffActive : ""}`}
                  onClick={() => setDifficulty(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Song length (m:ss)</span>
              <input
                type="text"
                className={styles.bpmInput}
                placeholder="3:00"
                value={ytLength}
                onChange={(e) => setYtLength(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>BPM</span>
              <input
                type="number"
                className={styles.bpmInput}
                min={40}
                max={300}
                value={bpm}
                onChange={(e) =>
                  setBpm(Math.max(40, Math.min(300, Number(e.target.value) || 120)))
                }
              />
            </div>
          </div>

          <div className={styles.fieldRow}>{nameField}</div>

          <button
            type="button"
            className={styles.generate}
            disabled={ytUrl.trim().length === 0}
            onClick={handleYouTube}
          >
            Add &amp; play
          </button>

          <p className={styles.note}>
            The video plays in an embedded player (audio isn&apos;t downloaded).
            Notes are placed on a BPM grid since the audio can&apos;t be analyzed,
            and timing is looser than uploaded files — use the calibration control
            on the play screen to line it up. Ads on non-Premium accounts may
            interrupt playback.
          </p>
        </>
      )}

      {error && <div className={styles.notice}>{error}</div>}
      {info && <div className={styles.info}>{info}</div>}
      {inspecting && <div className={styles.info}>Reading Clone Hero song…</div>}

      {/* Clone Hero import branch */}
      {mode === "file" && chPkg && (
        <>
          <dl className={styles.meta}>
            <Row label="Imported" value={chPkg.metadata.name} />
            {chPkg.metadata.artist && (
              <Row label="Artist" value={chPkg.metadata.artist} />
            )}
            {chPkg.metadata.charter && (
              <Row label="Charter" value={chPkg.metadata.charter} />
            )}
            <Row label="Format" value={chPkg.format === "midi" ? "notes.mid" : "notes.chart"} />
            <Row label="Audio" value={chPkg.audioUrl ? "included" : "none (silent play)"} />
          </dl>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Difficulty (from the chart)</span>
            <div className={styles.difficulties}>
              {DIFFICULTIES.map((d) => {
                const available = chPkg.availableDifficulties.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!available}
                    className={`${styles.diffBtn} ${chDifficulty === d ? styles.diffActive : ""}`}
                    onClick={() => setChDifficulty(d)}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.fieldRow}>{nameField}</div>

          <button
            type="button"
            className={styles.generate}
            disabled={importing}
            onClick={handleImport}
          >
            {importing ? "Importing…" : "Import & play"}
          </button>

          <p className={styles.note}>
            Imported from a Clone Hero chart. The 5 frets map to the 5 lanes;
            sustains play as taps and chords are capped for touch. If timing feels
            off, nudge the calibration on the play screen.
          </p>
        </>
      )}

      {/* Audio upload branch */}
      {mode === "file" && !chPkg && meta && (
        <>
          <dl className={styles.meta}>
            <Row label="File" value={meta.name} />
            <Row label="Size" value={formatBytes(meta.size)} />
            <Row label="Type" value={meta.type} />
            <Row label="Duration" value={formatDuration(meta.durationSeconds)} />
          </dl>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Chart source</span>
            <div className={styles.segmented}>
              <button
                type="button"
                className={`${styles.segBtn} ${source === "analyze" ? styles.segActive : ""}`}
                onClick={() => setSource("analyze")}
              >
                Auto-analyze audio <em className={styles.beta}>beta</em>
              </button>
              <button
                type="button"
                className={`${styles.segBtn} ${source === "grid" ? styles.segActive : ""}`}
                onClick={() => setSource("grid")}
              >
                Simple BPM grid
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Difficulty</span>
            <div className={styles.difficulties}>
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`${styles.diffBtn} ${difficulty === d ? styles.diffActive : ""}`}
                  onClick={() => setDifficulty(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                BPM {source === "analyze" ? "(grid fallback)" : ""}
              </span>
              <input
                type="number"
                className={styles.bpmInput}
                min={40}
                max={300}
                value={bpm}
                onChange={(e) =>
                  setBpm(Math.max(40, Math.min(300, Number(e.target.value) || 120)))
                }
              />
            </div>
            {nameField}
          </div>

          {analyzing && (
            <div className={styles.progressTrack} aria-label="Analysis progress">
              <div
                className={styles.progressFill}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}

          <button
            type="button"
            className={styles.generate}
            disabled={!canGenerate}
            onClick={handleGenerate}
          >
            {generateLabel}
          </button>

          <p className={styles.note}>
            Auto-analyze decodes your audio and detects musical onsets in your
            browser (nothing is uploaded). It&apos;s a first pass — heavier
            server-side analysis and stem separation are planned; see the docs.
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}
