"use client";

/**
 * CalibrationPanel
 *
 * Lets the player nudge the audio/input sync offset. A positive offset brings
 * notes in earlier (for players who tap ahead of the beat); a negative one
 * pushes them later (late audio, e.g. Bluetooth headphones). The tap test
 * measures it for them. The debug readout shows raw song time vs. the
 * offset-adjusted chart time so sync issues are easy to diagnose.
 */

import styles from "./CalibrationPanel.module.css";

interface CalibrationPanelProps {
  calibrationOffsetMs: number;
  onAdjust: (deltaMs: number) => void;
  onReset: () => void;
  /** Opens the tap-along latency test. */
  onTapTest?: () => void;
  /** The tap test can't run mid-song. */
  tapTestDisabled?: boolean;
  /** One-line status, e.g. a latency-based starting value was applied. */
  note?: string;
  /** Optional live debug values. */
  songTimeMs?: number;
  chartTimeMs?: number;
}

export function CalibrationPanel({
  calibrationOffsetMs,
  onAdjust,
  onReset,
  onTapTest,
  tapTestDisabled,
  note,
  songTimeMs,
  chartTimeMs,
}: CalibrationPanelProps): React.JSX.Element {
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Calibration</span>
        <span className={styles.value}>
          {calibrationOffsetMs > 0 ? "+" : ""}
          {calibrationOffsetMs} ms
        </span>
      </div>

      <div className={styles.buttons}>
        <button type="button" onClick={() => onAdjust(-10)} className={styles.btn}>
          −10ms
        </button>
        <button type="button" onClick={onReset} className={styles.btnReset}>
          Reset
        </button>
        <button type="button" onClick={() => onAdjust(10)} className={styles.btn}>
          +10ms
        </button>
      </div>

      {onTapTest && (
        <button
          type="button"
          onClick={onTapTest}
          className={styles.tapTest}
          disabled={tapTestDisabled}
        >
          Tap test (headphones/Bluetooth)
        </button>
      )}

      {note && <p className={styles.note}>{note}</p>}

      {(songTimeMs !== undefined || chartTimeMs !== undefined) && (
        <div className={styles.debug}>
          {songTimeMs !== undefined && (
            <span>song {(songTimeMs / 1000).toFixed(2)}s</span>
          )}
          {chartTimeMs !== undefined && (
            <span>chart {(chartTimeMs / 1000).toFixed(2)}s</span>
          )}
        </div>
      )}
    </div>
  );
}
