/**
 * Core domain types for the rhythm game.
 *
 * These types are intentionally framework-agnostic: nothing here imports React
 * or touches the DOM. The goal is that all gameplay rules (scoring, hit
 * detection, timing) operate on plain data and are trivially unit-testable.
 */

/** Five-lane layout (Clone Hero / Rock Band style). */
export type Lane = 0 | 1 | 2 | 3 | 4;

export type Difficulty = "easy" | "medium" | "hard" | "expert";

/**
 * A "tap" is judged by a single touch as the gem crosses the hit line. A "hold"
 * (aka sustain) is judged by hitting the head like a tap AND then keeping the
 * lane pressed for the note's `durationMs` — Guitar Hero / Rock Band style.
 */
export type NoteType = "tap" | "hold";

export interface ChartNote {
  id: string;
  /** Note time in milliseconds, relative to song start (before calibration). */
  timeMs: number;
  lane: Lane;
  /** Sustain length in ms. Undefined / 0 means a plain tap. */
  durationMs?: number;
  type?: NoteType;
  /**
   * Star-power phrase this note belongs to (Guitar Hero / Clone Hero style).
   * Notes sharing an id form one phrase; hitting every note in the phrase
   * charges the star-power meter. Undefined = a normal note. Imported charts
   * keep their authored `S 2` phrases; other sources get phrases auto-marked.
   */
  starPhrase?: number;
  /**
   * Hammer-on / pull-off (touch adaptation): while the previous note was hit,
   * a HOPO auto-hits when it crosses the line with its lane already held —
   * slide or hold a finger instead of re-tapping fast runs. `.chart` imports
   * derive this from note spacing plus forced (`N 5`) / tap (`N 6`) flags;
   * other sources get naturals auto-marked. Undefined = never marked.
   */
  hopo?: boolean;
}

export interface RhythmChart {
  id: string;
  title: string;
  artist?: string;
  bpm?: number;
  /**
   * Chart-authored offset in ms. Added to every note time. Distinct from the
   * user's runtime calibration offset, which is a per-player preference.
   */
  offsetMs: number;
  difficulty: Difficulty;
  notes: ChartNote[];
}

export type HitRating = "perfect" | "great" | "good" | "miss";

/**
 * Lifecycle of a hold note's sustain, tracked once its head has been judged:
 *  - "holding":   head was hit, the lane is still pressed, sustain in progress.
 *  - "completed": the lane stayed pressed through the tail (sustain earned).
 *  - "dropped":   the lane was released early (sustain broken → combo break).
 *
 * A hold whose head is never hit is a plain "miss" (its head times out like any
 * tap) and never enters this state machine.
 */
export type HoldPhase = "holding" | "completed" | "dropped";

/** A non-miss judgement that actually awards points and advances combo. */
export type HitJudgement = Exclude<HitRating, "miss">;

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  /** Total notes in the chart; used to compute accuracy and completion. */
  totalNotes: number;
}

/**
 * Runtime view of a note. We never mutate the source ChartNote; instead the
 * engine tracks judgement state in a parallel structure keyed by note id.
 */
export interface NoteRuntimeState {
  judged: boolean;
  rating?: HitRating;
  /** When the note was judged, in song time ms (for fading feedback out). */
  judgedAtMs?: number;
  /**
   * Sustain lifecycle for hold notes. Undefined for taps and for holds whose
   * head has not been hit yet. Set to "holding" the instant the head is hit.
   */
  hold?: HoldPhase;
  /** Song time (ms) the sustain was started (head hit). */
  holdStartMs?: number;
  /** Song time (ms) the sustain resolved (completed or dropped). */
  holdEndMs?: number;
}

/** Transient feedback shown after a hit or miss, consumed by the renderer. */
export interface HitFeedback {
  id: string;
  lane: Lane;
  rating: HitRating;
  /** Song time the feedback was created, used to animate/expire it. */
  createdAtMs: number;
  /** Signed timing error in ms (negative = early, positive = late). */
  errorMs: number;
  /**
   * Marks feedback produced by a sustain resolving (rather than a plain tap) so
   * the renderer can label it "HOLD" / "DROP" instead of a timing rating.
   */
  hold?: "completed" | "dropped";
  /**
   * Marks the celebratory "STAR POWER" flare pushed when a star phrase is
   * completed (alongside the regular rating feedback for the hit itself).
   */
  star?: boolean;
}

/** Result of attempting to hit a note in a lane at a given time. */
export type HitResult =
  | {
      kind: "hit";
      note: ChartNote;
      rating: HitJudgement;
      errorMs: number;
      /** True when the note is a sustain whose tail must now be held. */
      startsHold: boolean;
    }
  | {
      kind: "miss-input";
      /** Tap registered but no note was within the good window. */
    };

/** Result of releasing a lane, resolving any sustain currently held there. */
export type HoldReleaseResult =
  | {
      /** The lane was released after holding the tail long enough — sustain earned. */
      kind: "completed";
      note: ChartNote;
    }
  | {
      /** The lane was released before the tail finished — sustain broken. */
      kind: "dropped";
      note: ChartNote;
      /** How many ms early the release was (relative to the sustain end). */
      earlyMs: number;
    }
  | {
      /** No sustain was being held in that lane. */
      kind: "none";
    };

export type GamePhase =
  | "idle"
  | "countdown"
  | "playing"
  | "paused"
  | "finished"
  /** The rock meter hit empty mid-song — booed off the stage, GH style. */
  | "failed";

/**
 * Star-power meter state. The meter is stored as a 0..1 fraction; while active
 * it drains linearly from `meter` starting at `activatedAtMs`, so the current
 * level is derived (see starPowerMeterAt) rather than mutated every frame.
 */
export interface StarPowerState {
  /** Stored meter fraction (0..1). While active: the level at activation/last award. */
  meter: number;
  active: boolean;
  /** Song time (ms) the drain clock started; only meaningful while active. */
  activatedAtMs: number;
  /** Star phrases completed this run (for results / metrics). */
  phrasesCompleted: number;
}

/** Progress of one star phrase during a run. */
export interface StarPhraseProgress {
  /** Notes in the phrase. */
  total: number;
  /** Notes hit so far. */
  hit: number;
  /** True once any note of the phrase was missed — the phrase awards nothing. */
  broken: boolean;
}
