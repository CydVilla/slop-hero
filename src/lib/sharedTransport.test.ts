import { describe, expect, it, vi } from "vitest";

import { createSharedTransport, createTransportState } from "./sharedTransport";

function fakeAudio() {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    getTimeMs: vi.fn(() => 1234),
    resume: vi.fn(),
    setRate: vi.fn(),
  };
}

describe("createSharedTransport", () => {
  it("passes every call straight through for a solo player", () => {
    const audio = fakeAudio();
    const [p1] = createSharedTransport(audio, () => 1, createTransportState(), () => 0);
    p1.play(5000);
    p1.play(5000); // practice loop re-seek, same tick — must still seek
    p1.stop();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(p1.getTimeMs()).toBe(1234);
  });

  it("collapses both players' simultaneous starts into one play", () => {
    const audio = fakeAudio();
    let t = 0;
    const [p1, p2] = createSharedTransport(audio, () => 2, createTransportState(), () => t);
    p1.play(0);
    t = 4;
    p2.play(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
    // A later, deliberate play (resume after pause) goes through.
    t = 5000;
    p1.play();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("keeps the song going until both players have stopped", () => {
    const audio = fakeAudio();
    const [p1, p2] = createSharedTransport(audio, () => 2, createTransportState(), () => 0);
    p1.play(0);
    p1.stop(); // P1 finished (or booed off) — P2 still playing
    expect(audio.stop).not.toHaveBeenCalled();
    p2.stop();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a restart", () => {
    const audio = fakeAudio();
    let t = 0;
    const [p1, p2] = createSharedTransport(audio, () => 2, createTransportState(), () => t);
    p1.stop();
    p2.stop();
    t = 100;
    p1.play(0);
    p2.play(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
    p1.stop();
    expect(audio.stop).toHaveBeenCalledTimes(1); // only the pre-restart stop
  });

  it("remembers who stopped when the handles are rebuilt", () => {
    const audio = fakeAudio();
    const state = createTransportState();
    const [p1] = createSharedTransport(audio, () => 2, state, () => 0);
    p1.stop(); // P1 done
    // Engine object changed (e.g. P2 paused) → handles rebuilt on the same state.
    const [, p2] = createSharedTransport(audio, () => 2, state, () => 0);
    p2.stop();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });
});
