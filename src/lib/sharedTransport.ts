/**
 * Shared transport: two rhythm-game players driving ONE audio clock.
 *
 * Each player's game hook believes it owns the transport — it plays on the
 * count-in, pauses, and stops when its run ends. With two players on one song
 * that would be wrong twice over: the second player's start would re-seek the
 * song, and the first player to finish (or get booed off) would stop the music
 * on the other. This wrapper hands each player its own controls and arbitrates:
 *
 *  - play: duplicate requests for the same position within a few ms (both
 *    players' count-ins ending, both resuming) collapse into one.
 *  - stop: the song only stops once EVERY active player has stopped; a
 *    finished player just stops listening.
 *  - everything else passes straight through.
 *
 * With one active player every call passes straight through, so solo play —
 * including practice loops that re-seek mid-song — behaves exactly as before.
 */

import type { GameAudioControls } from "@/hooks/useRhythmGame";

/** Play requests for the same position closer together than this are one. */
const DUPLICATE_PLAY_MS = 60;

/**
 * Arbitration state. Owned by the caller (e.g. a ref) so it survives the
 * handles being rebuilt whenever the underlying engine object changes.
 */
export interface SharedTransportState {
  stopped: [boolean, boolean];
  lastPlay: { at: number; from: number | undefined } | null;
}

export function createTransportState(): SharedTransportState {
  return { stopped: [false, false], lastPlay: null };
}

export function createSharedTransport(
  audio: GameAudioControls,
  activePlayers: () => number,
  state: SharedTransportState = createTransportState(),
  now: () => number = () => performance.now(),
): [GameAudioControls, GameAudioControls] {
  const { stopped } = state;

  const handle = (player: 0 | 1): GameAudioControls => ({
    resume: () => audio.resume?.(),
    play: (fromMs?: number) => {
      stopped[player] = false;
      const t = now();
      const solo = activePlayers() < 2;
      const last = state.lastPlay;
      if (!solo && last && last.from === fromMs && t - last.at < DUPLICATE_PLAY_MS) return;
      state.lastPlay = { at: t, from: fromMs };
      return audio.play(fromMs);
    },
    pause: () => audio.pause(),
    stop: () => {
      stopped[player] = true;
      const active = Math.min(2, Math.max(1, activePlayers()));
      if (stopped.slice(0, active).every(Boolean)) {
        state.lastPlay = null;
        audio.stop();
      }
    },
    getTimeMs: () => audio.getTimeMs(),
    setRate: (rate: number) => audio.setRate?.(rate),
  });

  return [handle(0), handle(1)];
}
