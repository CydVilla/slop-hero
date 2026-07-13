/**
 * Tiny synthesized sound effects (no audio assets).
 *
 * Guitar Hero punishes a miss with an audible fret-buzz "flub" — that little
 * sting is a surprising amount of the feel, so we synthesize one with Web
 * Audio: a short burst of low-passed noise plus a dull low "thunk".
 *
 * Uses its own lazy AudioContext (created on first play, i.e. mid-gameplay,
 * well after the user gesture) so it works identically in Web Audio, silent,
 * and YouTube playback modes. Every call is best-effort: on any failure the
 * game simply stays silent.
 */

let ctx: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;
/** Throttle so a chord wipe-out doesn't stack N buzzes into one loud blast. */
let lastBuzzAt = 0;

const BUZZ_THROTTLE_MS = 90;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
  return ctx;
}

/** 200ms of white noise, generated once and reused for every buzz. */
function getNoiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ac.sampleRate) return noiseBuffer;
  const length = Math.floor(ac.sampleRate * 0.2);
  noiseBuffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/**
 * The miss sound: a muted fret-buzz. Safe to call from anywhere, any mode;
 * throttled so simultaneous misses produce a single buzz.
 */
export function playMissBuzz(): void {
  const now = performance.now();
  if (now - lastBuzzAt < BUZZ_THROTTLE_MS) return;
  lastBuzzAt = now;

  const ac = getContext();
  if (!ac) return;

  try {
    const t0 = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.16, t0);
    out.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
    out.connect(ac.destination);

    // Scratchy string noise, low-passed so it reads as a muffled flub.
    const noise = ac.createBufferSource();
    noise.buffer = getNoiseBuffer(ac);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(520, t0);
    lp.frequency.exponentialRampToValueAtTime(140, t0 + 0.12);
    noise.connect(lp);
    lp.connect(out);
    noise.start(t0);
    noise.stop(t0 + 0.16);

    // A dull low thunk underneath, pitch sagging like a slack string.
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(110, t0);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
    const oscGain = ac.createGain();
    oscGain.gain.setValueAtTime(0.5, t0);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    osc.connect(oscGain);
    oscGain.connect(out);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  } catch {
    // Best-effort: a failed buzz should never break gameplay.
  }
}
