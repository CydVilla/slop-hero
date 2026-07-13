"use client";

/**
 * ScorePanel
 *
 * Low-frequency UI: reads the React score state (updated only on hits/misses,
 * not every frame). Pure presentational component.
 */

import { accuracyPercent, comboMultiplier } from "@/game/scoring";
import { rockMeterZone } from "@/game/rockMeter";
import { STAR_POWER } from "@/game/constants";
import type { ScoreState } from "@/game/types";

import styles from "./ScorePanel.module.css";

interface ScorePanelProps {
  score: ScoreState;
  /** Live GH-style star rating (0–5) for the run so far. */
  stars: number;
  /** Rock meter 0..1; the gauge goes red near empty (= song fail). */
  rockMeter: number;
  /** Whether star power is blazing (doubles the shown multiplier). */
  starPowerActive: boolean;
}

export function ScorePanel({
  score,
  stars,
  rockMeter,
  starPowerActive,
}: ScorePanelProps): React.JSX.Element {
  const accuracy = accuracyPercent(score);
  const multiplier =
    comboMultiplier(score.combo) * (starPowerActive ? STAR_POWER.scoreMultiplier : 1);
  const zone = rockMeterZone(rockMeter);

  return (
    <div className={styles.panel}>
      <div className={styles.scoreBlock}>
        <span className={styles.scoreValue}>{score.score.toLocaleString()}</span>
        <span className={styles.scoreLabel}>SCORE</span>
      </div>

      <div className={styles.starRow} role="img" aria-label={`${stars} of 5 stars`}>
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={i < stars ? styles.starOn : styles.starOff}>
            ★
          </span>
        ))}
      </div>

      <div className={styles.comboBlock}>
        <span className={styles.comboValue}>{score.combo}</span>
        <span className={styles.comboLabel}>
          COMBO{" "}
          {multiplier > 1 ? (
            <em className={starPowerActive ? styles.multStar : styles.mult}>
              ×{multiplier}
            </em>
          ) : null}
        </span>
      </div>

      <div
        className={styles.rockMeter}
        role="meter"
        aria-label="Rock meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(rockMeter * 100)}
      >
        <div
          className={`${styles.rockFill} ${styles[`rock_${zone}`]}`}
          style={{ width: `${Math.round(rockMeter * 100)}%` }}
        />
      </div>

      <dl className={styles.stats}>
        <Stat label="Acc" value={`${accuracy.toFixed(1)}%`} />
        <Stat label="Max" value={score.maxCombo.toString()} />
        <Stat label="Perfect" value={score.perfect.toString()} tone="perfect" />
        <Stat label="Great" value={score.great.toString()} tone="great" />
        <Stat label="Good" value={score.good.toString()} tone="good" />
        <Stat label="Miss" value={score.miss.toString()} tone="miss" />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "perfect" | "great" | "good" | "miss";
}): React.JSX.Element {
  return (
    <div className={`${styles.stat} ${tone ? styles[tone] : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
