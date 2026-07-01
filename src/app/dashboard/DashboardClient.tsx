"use client";

/**
 * Metrics dashboard.
 *
 * Shows two lenses on the same anonymous data:
 *   - "All players"  — server-wide aggregates from /api/metrics/*.
 *   - "This device"  — aggregates computed locally from this browser's history,
 *                      so the dashboard is useful even with no backend store.
 *
 * It also surfaces the self-improvement engine's recommendations and the exact
 * bounded tuning it would commit, plus privacy controls (opt-out / clear data).
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TUNING } from "@/game/tuning";
import type { Difficulty } from "@/game/types";
import { aggregate } from "@/lib/metrics/aggregate";
import { deriveInsights, type InsightsReport } from "@/lib/metrics/insights";
import {
  clearLocalSessions,
  getLocalSessions,
  isOptedOut,
  setOptedOut,
} from "@/lib/metrics/client";
import type { MetricsSummary, PlaySessionEvent } from "@/lib/metrics/types";

import styles from "./dashboard.module.css";

type View = "all" | "device";

const DIFF_COLOR: Record<Difficulty, string> = {
  easy: "#22c55e",
  medium: "#eab308",
  hard: "#f97316",
  expert: "#ef4444",
};

export function DashboardClient(): React.JSX.Element {
  const [view, setView] = useState<View>("all");
  const [serverSummary, setServerSummary] = useState<MetricsSummary | null>(null);
  const [serverReport, setServerReport] = useState<InsightsReport | null>(null);
  const [serverHasData, setServerHasData] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [localEvents, setLocalEvents] = useState<PlaySessionEvent[]>([]);
  const [optedOut, setOptedOutState] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshLocal = useCallback(() => {
    setLocalEvents(getLocalSessions());
    setOptedOutState(isOptedOut());
  }, []);

  useEffect(() => {
    refreshLocal();

    let cancelled = false;
    fetch("/api/metrics/insights")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((data: { summary: MetricsSummary; report: InsightsReport }) => {
        if (cancelled) return;
        setServerSummary(data.summary);
        setServerReport(data.report);
        const hasData = data.summary.totalSessions > 0;
        setServerHasData(hasData);
        // Default to whichever lens actually has data.
        if (!hasData) setView("device");
      })
      .catch(() => {
        if (!cancelled) {
          setServerError(true);
          setView("device");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshLocal]);

  const localSummary = useMemo(() => aggregate(localEvents), [localEvents]);
  const localReport = useMemo(
    () => deriveInsights(localSummary, TUNING),
    [localSummary],
  );

  const summary = view === "all" ? serverSummary : localSummary;
  const report = view === "all" ? serverReport : localReport;

  const toggleOptOut = useCallback(() => {
    const next = !optedOut;
    setOptedOut(next);
    setOptedOutState(next);
  }, [optedOut]);

  const onClear = useCallback(() => {
    clearLocalSessions();
    refreshLocal();
  }, [refreshLocal]);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          ‹ Home
        </Link>
        <div className={styles.viewToggle} role="tablist" aria-label="Data source">
          <button
            type="button"
            role="tab"
            aria-selected={view === "all"}
            className={view === "all" ? styles.viewActive : styles.viewBtn}
            onClick={() => setView("all")}
          >
            All players
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "device"}
            className={view === "device" ? styles.viewActive : styles.viewBtn}
            onClick={() => setView("device")}
          >
            This device
          </button>
        </div>
      </header>

      <div className={styles.intro}>
        <h1 className={styles.title}>Metrics &amp; self-improvement</h1>
        <p className={styles.subtitle}>
          Anonymous, gameplay-only telemetry — no accounts, no personal data. It
          feeds an autonomous loop that proposes small, bounded tuning changes
          (default sync + note density) via pull request. See{" "}
          <span className={styles.code}>docs/metricsAndSelfImprovement.md</span>.
        </p>
      </div>

      {loading ? (
        <p className={styles.muted}>Loading metrics…</p>
      ) : (
        <>
          {view === "all" && !serverHasData && (
            <p className={styles.notice}>
              {serverError
                ? "Couldn't reach the server metrics store — showing this device instead."
                : "No server-wide data yet. Play a few songs, then check back — or view this device's history."}
            </p>
          )}

          {!summary || summary.totalSessions === 0 ? (
            <p className={styles.notice}>
              No sessions recorded yet on{" "}
              {view === "all" ? "the server" : "this device"}. Go{" "}
              <Link href="/play" className={styles.inlineLink}>
                play a song
              </Link>{" "}
              to generate some data.
            </p>
          ) : (
            <Sections summary={summary} report={report} />
          )}
        </>
      )}

      <section className={styles.privacy}>
        <h2 className={styles.sectionTitle}>Your data &amp; privacy</h2>
        <p className={styles.muted}>
          This device has <strong>{localEvents.length}</strong> recorded session
          {localEvents.length === 1 ? "" : "s"} stored locally. Sending anonymous
          results to the shared metrics is{" "}
          <strong>{optedOut ? "off" : "on"}</strong>.
        </p>
        <div className={styles.privacyActions}>
          <button type="button" className={styles.secondaryBtn} onClick={toggleOptOut}>
            {optedOut ? "Turn sharing on" : "Turn sharing off"}
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={onClear}
            disabled={localEvents.length === 0}
          >
            Clear this device&apos;s data
          </button>
        </div>
      </section>
    </main>
  );
}

function Sections({
  summary,
  report,
}: {
  summary: MetricsSummary;
  report: InsightsReport | null;
}): React.JSX.Element {
  const maxBucket = Math.max(1, ...summary.accuracyBuckets.map((b) => b.count));

  return (
    <>
      <section className={styles.kpis}>
        <Kpi label="Sessions" value={summary.totalSessions.toLocaleString()} />
        <Kpi label="Players" value={summary.uniquePlayers.toLocaleString()} />
        <Kpi label="Notes hit" value={summary.totalNotesHit.toLocaleString()} />
        <Kpi label="Avg accuracy" value={`${summary.overallAccuracy.toFixed(1)}%`} />
        <Kpi
          label="Completion"
          value={`${Math.round(summary.completionRate * 100)}%`}
        />
        <Kpi
          label="Median calibration"
          value={`${summary.medianCalibrationOffsetMs > 0 ? "+" : ""}${summary.medianCalibrationOffsetMs}ms`}
        />
      </section>

      <div className={styles.columns}>
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Accuracy distribution</h2>
          <ul className={styles.bars}>
            {summary.accuracyBuckets.map((b) => (
              <li key={b.label} className={styles.barRow}>
                <span className={styles.barLabel}>{b.label}</span>
                <span className={styles.barTrack}>
                  <span
                    className={styles.barFill}
                    style={{ width: `${(b.count / maxBucket) * 100}%` }}
                  />
                </span>
                <span className={styles.barValue}>{b.count}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>By difficulty</h2>
          {summary.byDifficulty.length === 0 ? (
            <p className={styles.muted}>No difficulty data yet.</p>
          ) : (
            <ul className={styles.bars}>
              {summary.byDifficulty.map((d) => (
                <li key={d.difficulty} className={styles.barRow}>
                  <span
                    className={styles.barLabel}
                    style={{ color: DIFF_COLOR[d.difficulty] }}
                  >
                    {d.difficulty}
                  </span>
                  <span className={styles.barTrack}>
                    <span
                      className={styles.barFill}
                      style={{
                        width: `${Math.min(100, d.avgMissRate * 100)}%`,
                        background: DIFF_COLOR[d.difficulty],
                      }}
                    />
                  </span>
                  <span className={styles.barValue}>
                    {Math.round(d.avgMissRate * 100)}% miss · {d.plays}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>Autonomous tuning recommendations</h2>
        {report && report.recommendations.length > 0 ? (
          <ul className={styles.recs}>
            {report.recommendations.map((rec) => (
              <li
                key={rec.id}
                className={`${styles.rec} ${styles[rec.severity] ?? ""}`}
              >
                <span className={styles.recSeverity}>{rec.severity}</span>
                <div>
                  <strong className={styles.recTitle}>{rec.title}</strong>
                  <p className={styles.recDetail}>{rec.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>No recommendations right now.</p>
        )}
        {report && report.actionable && (
          <div className={styles.tuningBox}>
            <span className={styles.tuningTag}>Would commit</span>
            <code className={styles.tuningCode}>
              default calibration {report.recommendedTuning.defaultCalibrationOffsetMs}ms ·
              density{" "}
              {(Object.keys(report.recommendedTuning.difficultyDensityScale) as Difficulty[])
                .map((d) => `${d}=${report.recommendedTuning.difficultyDensityScale[d]}`)
                .join(" ")}
            </code>
          </div>
        )}
      </section>

      {summary.topTracks.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Tracks</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Diff</th>
                  <th>Plays</th>
                  <th>Avg acc</th>
                  <th>Miss</th>
                  <th>Best</th>
                </tr>
              </thead>
              <tbody>
                {summary.topTracks.slice(0, 12).map((t) => (
                  <tr key={t.chartId}>
                    <td>{t.title}</td>
                    <td style={{ color: DIFF_COLOR[t.difficulty] }}>{t.difficulty}</td>
                    <td>{t.plays}</td>
                    <td>{t.avgAccuracy.toFixed(1)}%</td>
                    <td>{Math.round(t.avgMissRate * 100)}%</td>
                    <td>{t.bestScore.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiValue}>{value}</span>
      <span className={styles.kpiLabel}>{label}</span>
    </div>
  );
}
