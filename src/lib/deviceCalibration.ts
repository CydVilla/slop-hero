/**
 * The player's calibration, remembered on this device.
 *
 * Calibration depends on the audio route (Bluetooth headphones vs. speakers),
 * which is a property of the device setup, not of a song — so once a player
 * dials it in (buttons or the tap test) every later song starts from it.
 * Device-local like the leaderboards; never sent anywhere except as the
 * existing anonymous per-session metric.
 */

import { clampCalibration } from "@/game/calibration";

const KEY = "slop-hero:calibration-ms";

export function loadDeviceCalibration(): number | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampCalibration(value) : null;
  } catch {
    return null;
  }
}

export function saveDeviceCalibration(ms: number): void {
  try {
    window.localStorage.setItem(KEY, String(clampCalibration(ms)));
  } catch {
    // Storage blocked (private mode) — calibration still applies this session.
  }
}

export function clearDeviceCalibration(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing stored to clear.
  }
}
