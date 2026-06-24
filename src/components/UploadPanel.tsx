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

import { useCallback, useRef, useState } from "react";

import { generateAutoChart } from "@/game/autoMapper";
import type { Difficulty, RhythmChart } from "@/game/types";
import { analyzeFileToChart } from "@/lib/analyzeClient";
import {
  importCloneHeroPackage,
  inspectCloneHeroFile,
  type CloneHeroPackage,
} from "@/lib/cloneHeroClient";

import styles from "./UploadPanel.module.css";

export interface UploadResult {
  /** Playable audio. Undefined => silent/demo mode (e.g. a chart with no audio). */
  audioUrl?: string;
  chart: RhythmChart;
  fileName: string;
  contributor: string;
}

interface UploadPanelProps {
  onReady: (result: UploadResult) => void;
}

interface FileMeta {
  name: string;
  size: number;
  type: string;
  durationSeconds: number | null;
}

type ChartSource = "analyze" | "grid";

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

export function UploadPanel({ onReady }: UploadPanelProps): React.JSX.Element {
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

  // Clone Hero import state.
  const [chPkg, setChPkg] = useState<CloneHeroPackage | null>(null);
  const [chDifficulty, setChDifficulty] = useState<Difficulty>("expert");
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);

  const previousUrlRef = useRef<string | null>(null);
  const fileRef = useRef<File | null>(null);

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

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

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
      <label
        className={styles.dropzone}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="audio/*,.zip,.chart,.mid,.midi,.sng,.ini"
          className={styles.hiddenInput}
          onChange={onInputChange}
        />
        <span className={styles.dropTitle}>Tap to choose a file</span>
        <span className={styles.dropHint}>
          or drag &amp; drop · audio (mp3, wav, ogg, m4a) or a Clone Hero song
          (.sng / .zip / .chart / .mid)
        </span>
      </label>

      {error && <div className={styles.notice}>{error}</div>}
      {info && <div className={styles.info}>{info}</div>}
      {inspecting && <div className={styles.info}>Reading Clone Hero song…</div>}

      {/* Clone Hero import branch */}
      {chPkg && (
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
      {!chPkg && meta && (
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
