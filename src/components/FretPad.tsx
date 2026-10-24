"use client";

/**
 * FretPad
 *
 * Rock Band-style fret pads for tabletop posture: with a foldable half-folded
 * on a table, the highway stands up on the top half (eyes up) and these five
 * big pads lie flat on the bottom half (hands down) — closer to a guitar
 * controller than tapping notes on the highway itself.
 *
 * Touch rules match the highway exactly (see GameCanvas): a press judges the
 * lane and anchors any sustain; sliding moves the positional hold for HOPOs
 * without judging or dropping the sustain; wiggling feeds whammy; lifting
 * releases the anchored lane. The ★ strip unleashes star power.
 */

import { useCallback, useRef, useState } from "react";

import styles from "./FretPad.module.css";

import { LANE_COLORS, LANE_COUNT, LANES } from "@/game/constants";
import type { Lane } from "@/game/types";

interface FretPadProps {
  style?: React.CSSProperties;
  onLanePress: (lane: Lane) => void;
  onLaneRelease: (lane: Lane) => void;
  onLaneHold: (lane: Lane) => void;
  onLaneUnhold: (lane: Lane) => void;
  onWhammy: (lane: Lane) => void;
  onActivateStarPower: () => void;
  /** Switch back to tapping the highway. */
  onExit: () => void;
}

function laneAt(el: HTMLElement, clientX: number): Lane {
  const r = el.getBoundingClientRect();
  const i = Math.floor(((clientX - r.left) / Math.max(r.width, 1)) * LANE_COUNT);
  return Math.min(LANE_COUNT - 1, Math.max(0, i)) as Lane;
}

export function FretPad({
  style,
  onLanePress,
  onLaneRelease,
  onLaneHold,
  onLaneUnhold,
  onWhammy,
  onActivateStarPower,
  onExit,
}: FretPadProps): React.JSX.Element {
  const anchors = useRef(new Map<number, Lane>());
  const hovers = useRef(new Map<number, Lane>());
  const lastPos = useRef(new Map<number, { x: number; y: number }>());
  const [lit, setLit] = useState<ReadonlySet<Lane>>(new Set());

  const refreshLit = useCallback(() => setLit(new Set(hovers.current.values())), []);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const lane = laneAt(e.currentTarget, e.clientX);
    anchors.current.set(e.pointerId, lane);
    hovers.current.set(e.pointerId, lane);
    lastPos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort; the maps still route the release.
    }
    onLanePress(lane);
    onLaneHold(lane);
    refreshLit();
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const anchor = anchors.current.get(e.pointerId);
    if (anchor === undefined) return;
    const lane = laneAt(e.currentTarget, e.clientX);
    const hover = hovers.current.get(e.pointerId);
    if (lane !== hover) {
      if (hover !== undefined) onLaneUnhold(hover);
      onLaneHold(lane);
      hovers.current.set(e.pointerId, lane);
      refreshLit();
    }
    const last = lastPos.current.get(e.pointerId);
    if (last) {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (dx * dx + dy * dy >= 16) {
        onWhammy(anchor);
        lastPos.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    }
  };

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const anchor = anchors.current.get(e.pointerId);
    if (anchor === undefined) return;
    const hover = hovers.current.get(e.pointerId);
    anchors.current.delete(e.pointerId);
    hovers.current.delete(e.pointerId);
    lastPos.current.delete(e.pointerId);
    if (hover !== undefined) onLaneUnhold(hover);
    onLaneRelease(anchor);
    refreshLit();
  };

  return (
    <div className={styles.root} style={style}>
      <div className={styles.topRow}>
        <button
          type="button"
          className={styles.star}
          onPointerDown={(e) => {
            e.preventDefault();
            onActivateStarPower();
          }}
        >
          ★ STAR POWER
        </button>
        <button type="button" className={styles.exit} onClick={onExit}>
          Tap highway instead
        </button>
      </div>
      <div
        className={styles.pads}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        role="group"
        aria-label="Fret pads — press the lane as its note reaches the line"
      >
        {LANES.map((lane) => (
          <div
            key={lane}
            className={`${styles.pad} ${lit.has(lane) ? styles.padLit : ""}`}
            style={{ "--lane": LANE_COLORS[lane] } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
