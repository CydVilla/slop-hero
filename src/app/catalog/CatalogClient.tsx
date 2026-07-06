"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { LANE_COLORS } from "@/game/constants";
import {
  getCatalog,
  refreshLibraryTracks,
  trackNoteCount,
  trackToActiveSong,
  type CatalogTrack,
} from "@/data/tracks";
import { setActiveSong } from "@/lib/activeSong";
import {
  communityChartToActiveSong,
  fetchCommunityChart,
  fetchCommunityList,
  type CommunityChartRecord,
} from "@/lib/community/client";
import { deleteSong } from "@/lib/songLibrary";

import styles from "./catalog.module.css";

const DIFF_COLOR: Record<string, string> = {
  easy: LANE_COLORS[0],
  medium: LANE_COLORS[2],
  hard: LANE_COLORS[4],
  expert: LANE_COLORS[1],
};

export function CatalogClient(): React.JSX.Element {
  const router = useRouter();
  // Built-ins render immediately; saved songs merge in once IndexedDB loads.
  const [tracks, setTracks] = useState<CatalogTrack[]>(() => getCatalog());
  const [community, setCommunity] = useState<CommunityChartRecord[]>([]);
  const [communityConfigured, setCommunityConfigured] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void refreshLibraryTracks().then(() => {
      if (!cancelled) setTracks(getCatalog());
    });
    void fetchCommunityList().then((list) => {
      if (cancelled) return;
      setCommunityConfigured(list.configured);
      setCommunity(list.items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const removeSaved = useCallback(async (track: CatalogTrack) => {
    await deleteSong(track.id);
    await refreshLibraryTracks();
    setTracks(getCatalog());
  }, []);

  const playCommunity = useCallback(
    async (item: CommunityChartRecord) => {
      setLoadingId(item.id);
      try {
        const record = await fetchCommunityChart(item.id);
        const song = record ? communityChartToActiveSong(record) : null;
        if (!song) return;
        setActiveSong(song);
        router.push("/play");
      } finally {
        setLoadingId(null);
      }
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
          royalty-free music and charts matched to the audio; songs you add are
          saved on this device so they survive reloads. Want to add yours?{" "}
          <Link href="/upload" className={styles.inlineLink}>
            Add a song
          </Link>
          , chart one in the{" "}
          <Link href="/editor" className={styles.inlineLink}>
            editor
          </Link>
          , or open a PR — see <span className={styles.code}>CONTRIBUTING.md</span>.
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
                <span className={styles.badge}>just added</span>
              )}
              {track.source === "library" && (
                <span className={styles.badge}>saved on this device</span>
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
              <span className={styles.footerBtns}>
                {track.source === "library" && (
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => void removeSaved(track)}
                    aria-label={`Remove ${track.title} from this device`}
                  >
                    Remove
                  </button>
                )}
                <button
                  type="button"
                  className={styles.playBtn}
                  onClick={() => play(track)}
                >
                  Play
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {communityConfigured && (
        <>
          <h2 className={styles.sectionTitle}>Community charts</h2>
          <p className={styles.sectionHint}>
            Charts published by other players from the{" "}
            <Link href="/editor" className={styles.inlineLink}>
              chart editor
            </Link>
            . Only the notes and (optionally) a YouTube link are shared — never
            audio files. Charts without a video play in silent mode.
          </p>
          {community.length === 0 ? (
            <p className={styles.sectionHint}>
              Nothing here yet — be the first: open the editor, make a chart,
              and press Publish.
            </p>
          ) : (
            <ul className={styles.grid}>
              {community.map((item) => (
                <li key={item.id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <span
                      className={styles.diff}
                      style={{ "--diff": DIFF_COLOR[item.difficulty] } as React.CSSProperties}
                    >
                      {item.difficulty}
                    </span>
                    <span className={styles.badge}>
                      {item.youtubeId ? "youtube" : "chart only"}
                    </span>
                  </div>

                  <h2 className={styles.trackTitle}>{item.title}</h2>
                  <p className={styles.artist}>{item.artist ?? "—"}</p>

                  <dl className={styles.specs}>
                    <span>{item.bpm ? `${Math.round(item.bpm)} BPM` : "— BPM"}</span>
                    <span>{item.noteCount} notes</span>
                    <span>{item.durationSeconds}s</span>
                  </dl>

                  <div className={styles.cardFooter}>
                    <span className={styles.contributor}>
                      charted by <strong>{item.contributor}</strong>
                    </span>
                    <button
                      type="button"
                      className={styles.playBtn}
                      disabled={loadingId === item.id}
                      onClick={() => void playCommunity(item)}
                    >
                      {loadingId === item.id ? "Loading…" : "Play"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
