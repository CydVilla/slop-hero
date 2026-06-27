"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { LANE_COLORS } from "@/game/constants";
import {
  getCatalog,
  trackNoteCount,
  trackToActiveSong,
  type CatalogTrack,
} from "@/data/tracks";
import { setActiveSong } from "@/lib/activeSong";

import styles from "./catalog.module.css";

const DIFF_COLOR: Record<string, string> = {
  easy: LANE_COLORS[0],
  medium: LANE_COLORS[2],
  hard: LANE_COLORS[4],
  expert: LANE_COLORS[1],
};

export function CatalogClient(): React.JSX.Element {
  const router = useRouter();
  // Snapshot the catalog once on mount (includes any session uploads).
  const [tracks] = useState<CatalogTrack[]>(() => getCatalog());

  const rows = useMemo(
    () =>
      tracks.map((t) => ({
        track: t,
        notes: trackNoteCount(t),
      })),
    [tracks],
  );

  const play = useCallback(
    (track: CatalogTrack) => {
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

      <div className={styles.intro}>
        <h1 className={styles.title}>Track catalog</h1>
        <p className={styles.subtitle}>
          Every playable track and who added it. Built-in tracks come with
          royalty-free music and charts matched to the audio. Want to add
          yours?{" "}
          <Link href="/upload" className={styles.inlineLink}>
            Add a song
          </Link>{" "}
          or open a PR — see <span className={styles.code}>CONTRIBUTING.md</span>.
        </p>
      </div>

      <ul className={styles.grid}>
        {rows.map(({ track, notes }) => (
          <li key={track.id} className={styles.card}>
            <div className={styles.cardTop}>
              <span
                className={styles.diff}
                style={{ "--diff": DIFF_COLOR[track.difficulty] } as React.CSSProperties}
              >
                {track.difficulty}
              </span>
              {track.source === "session" && (
                <span className={styles.badge}>this session</span>
              )}
            </div>

            <h2 className={styles.trackTitle}>{track.title}</h2>
            <p className={styles.artist}>{track.artist}</p>

            <dl className={styles.specs}>
              <span>{track.bpm} BPM</span>
              <span>{notes} notes</span>
              <span>{track.durationSeconds}s</span>
            </dl>

            <div className={styles.cardFooter}>
              <span className={styles.contributor}>
                added by{" "}
                {track.contributorUrl ? (
                  <a href={track.contributorUrl} target="_blank" rel="noreferrer">
                    {track.contributor}
                  </a>
                ) : (
                  <strong>{track.contributor}</strong>
                )}
              </span>
              <button type="button" className={styles.playBtn} onClick={() => play(track)}>
                Play
              </button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
