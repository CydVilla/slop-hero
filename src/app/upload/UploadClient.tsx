"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { UploadPanel, type UploadResult } from "@/components/UploadPanel";
import { addSessionTrack, trackToActiveSong, type CatalogTrack } from "@/data/tracks";
import { chartDurationMs } from "@/game/chartUtils";
import { setActiveSong } from "@/lib/activeSong";

import styles from "./upload.module.css";

export function UploadClient({
  youtubeOnly = false,
}: {
  youtubeOnly?: boolean;
}): React.JSX.Element {
  const router = useRouter();

  const handleReady = useCallback(
    (result: UploadResult) => {
      // Register the upload in the (session-scoped) catalog so it shows up
      // alongside built-in tracks with attribution.
      const track: CatalogTrack = {
        id: `session-${Date.now()}`,
        title: result.chart.title,
        artist: result.chart.artist ?? "Your upload",
        contributor: result.contributor,
        difficulty: result.chart.difficulty,
        bpm: result.chart.bpm ?? 120,
        durationSeconds: Math.round(chartDurationMs(result.chart) / 1000),
        addedAt: new Date().toISOString().slice(0, 10),
        source: "session",
        audioUrl: result.audioUrl,
        youtubeId: result.youtubeId,
        build: () => result.chart,
      };
      addSessionTrack(track);
      setActiveSong(trackToActiveSong(track));
      router.push("/play");
    },
    [router],
  );

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          ‹ Home
        </Link>
      </header>

      <section className={styles.body}>
        <div className={styles.intro}>
          <h1 className={styles.title}>Add a song</h1>
          <p className={styles.subtitle}>
            {youtubeOnly ? (
              <>
                Paste a YouTube link and we&apos;ll play it in an embedded player
                with a generated chart. (File upload isn&apos;t available on the
                Tesla browser.)
              </>
            ) : (
              <>
                Pick an audio file or Clone Hero song (.sng / .zip / .chart /
                .mid), or paste a YouTube link. Files stay in your browser —
                nothing is uploaded to a server. We&apos;ll generate a playable
                chart and add it to the catalog for this session.
              </>
            )}
          </p>
        </div>

        <UploadPanel onReady={handleReady} youtubeOnly={youtubeOnly} />

        <p className={styles.demoLink}>
          Browse the <Link href="/catalog">track catalog →</Link>
        </p>
      </section>
    </main>
  );
}
