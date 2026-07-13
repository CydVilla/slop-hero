# 0005 — HOPOs, whammy, and star-phrase authoring

- **Status:** Accepted (amends one point of [0004](./0004-guitar-feel-gameplay.md): community charts now carry `starPhrase`)
- **Date:** 2026-07-13

## Context

ADR-0004 landed star power, the rock meter, and the perspective highway. The
remaining gaps to the Guitar Hero / Clone Hero feel were the two mechanics
tied to a guitar controller — hammer-ons/pull-offs (no strum needed) and
whammying sustains for star power — plus the fact that only Clone Hero
imports could carry *authored* star phrases; editor charts always got the
auto-marked ones.

Both controller mechanics need a touch translation: there is no strum bar and
no whammy bar on a touchscreen.

## Decision

### HOPOs → "held lanes play themselves"

- On a controller, a HOPO needs fretting but no strum if the previous note
  was hit. Touch translation: a HOPO note **auto-hits when it crosses the
  line while its lane is physically held** (a finger resting there, slid
  there, or a key down) and the previous note (its whole chord) was hit.
  Fast cross-lane runs play by walking/sliding fingers instead of
  machine-gun tapping. Auto-hits land inside the perfect window and score as
  perfects.
- **Positional holds are separate from taps.** `holdLane`/`unholdLane`
  (counted per lane) track where fingers physically are; sliding onto a lane
  never judges a stray tap and never re-routes or drops the sustain the
  finger anchors. The canvas reports slides from `pointermove` using the
  same inverse perspective mapping as taps.
- Physical state survives resets: `heldLanesRef` is deliberately **not**
  cleared on restart — fingers/keys that are down stay down across a
  restart, and wiping the counts blinded auto-hits until a re-press (found
  live by the browser drive; see the test plan on the PR).
- **Marking follows Clone Hero:** natural HOPO = a non-chord note within
  65/192 of a beat of the previous note, on a lane the previous note(s)
  don't use; chords never. `.chart` imports also read authored `N 5`
  (forced, flips natural) and `N 6` (tap, always on) flags — previously
  dropped. Everything else gets naturals auto-marked at play time
  (`ensureHopos`), 170ms fallback when the BPM is unknown.
- HOPO gems render with a white ring over a darker core (the classic
  "tappable" look), preserved through star overlays and star-power tint.

### Whammy → "wiggle the held sustain"

- Wiggling the finger that holds a **star-phrase sustain** (≥4px pointer
  movement; key auto-repeat on desktop) trickles star-power meter at a
  quarter bar per 4 seconds of active wiggling — GH's whammy-for-SP, sized
  so a long sustain is worth roughly a phrase.
- The trickle is integrated per frame from a clamped delta and written to
  the **ref only** — no React state writes in the loop; the canvas already
  derives the meter from the ref, and activation/award transitions still go
  through the mirrored state. Whammied tails wobble and burn brighter.

### Star-phrase authoring + publishing

- The editor gains a **★ brush**: tap existing notes to star/unstar them;
  contiguous starred runs (judged per time group, so a mixed chord never
  splits a run) are renumbered into phrases at build time
  (`groupStarPhrases`). Loaded charts keep their existing phrases and are
  editable.
- **Amends ADR-0004:** the community sanitizer now carries `starPhrase`
  (integer, bounded) and `hopo` (`true` only) through publishing — rebuilt
  and validated, never passed through raw. With authoring in the editor,
  authored phrases are intent worth preserving; charts without them still
  get play-time auto-marking on the player's device.

## Options considered

- **Slide-as-tap** (pointer entering a lane counts as a press) — rejected:
  it turns every wobbly finger into stray taps and would let slides judge
  normal notes; positional holds keep taps deliberate and HOPOs honest.
- **HOPO auto-hit rated by arrival error** — moot: the auto-hit window IS
  the perfect window, so they score as perfects, like GH's full value.
- **Whammy on any sustain** — rejected: GH only rewards whammy during star
  phrases; keeping that scarcity makes star sustains special.
- **Editor phrase painting by time range** (drag a region) — deferred: the
  per-note brush reuses the existing grid interaction and undo model
  (tap again), and contiguity grouping gives ranges implicitly.

## Consequences

- `ChartNote.hopo` is an additive optional field; stored charts stay valid.
  A `.chart` import authored with *zero* HOPOs everywhere loses its explicit
  "no HOPOs" intent when published (only `true` flags survive) and will be
  re-auto-marked on players' devices — accepted edge.
- Holding all five lanes does not trivialise charts: every chain still needs
  its seed note tapped, chords must be tapped, and any miss breaks the chain
  — the same discipline a strum bar enforces.
- MIDI imports still get no authored HOPO/SP data (no note-off tracking in
  the minimal SMF reader) — unchanged from ADR-0004.
