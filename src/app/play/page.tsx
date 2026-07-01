"use client";

import { useEffect, useState } from "react";

import { GameScreen } from "@/components/GameScreen";
import { pickRandomTrack, trackToActiveSong } from "@/data/tracks";
import { analyzeUrlToChart } from "@/lib/analyzeClient";
import { getActiveSong, type ActiveSong } from "@/lib/activeSong";

/**
 * /play renders the active song handed off from the catalog or /upload. If
 * there is none (e.g. a direct visit or a hard reload), it falls back to a
 * random built-in track so the page is always playable.
 *
 * The song is resolved in an effect (client-only) rather than during render
 * because it depends on in-memory state (set on the client during navigation)
 * and on Math.random() for the fallback — both of which would differ between the
 * server and client and trigger a hydration mismatch.
 *
 * Built-in audio tracks additionally carry an `analyze` hint: we derive their
 * chart from the audio (onset detection) so the notes match the music, falling
 * back to the bundled grid chart if analysis fails.
 */
export default function PlayPage(): React.JSX.Element {
  const [session, setSession] = useState<ActiveSong | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const initial = getActiveSong() ?? trackToActiveSong(pickRandomTrack());
    setSession(initial);

    if (!initial.analyze || !initial.audioUrl) return;
    const { difficulty, bpmHint, artist } = initial.analyze;
    let cancelled = false;
    setAnalyzing(true);
    setProgress(0);

    analyzeUrlToChart(initial.audioUrl, {
      difficulty,
      bpmHint,
      title: initial.title,
      artist,
      onProgress: (p) => {
        if (!cancelled) setProgress(p);
      },
    })
      .then((chart) => {
        if (cancelled) return;
        // Replace the grid fallback with the onset-matched chart.
        setSession((s) => (s ? { ...s, chart, analyze: undefined } : s));
      })
      .catch(() => {
        // Keep the grid fallback chart already in the session.
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!session || analyzing) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          color: "rgba(255,255,255,0.6)",
          fontSize: "0.9rem",
          letterSpacing: "0.04em",
          textAlign: "center",
          padding: "1.5rem",
        }}
      >
        {analyzing
          ? `Matching notes to the music… ${Math.round(progress * 100)}%`
          : "Loading…"}
      </main>
    );
  }

  return (
    <GameScreen
      chart={session.chart}
      audioUrl={session.audioUrl}
      youtubeId={session.youtubeId}
      title={session.title}
      subtitle={session.subtitle}
      sessionMeta={session.meta}
    />
  );
}
