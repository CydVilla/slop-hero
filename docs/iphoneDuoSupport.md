# iPhone Duo (and foldable) support

Apple's first foldable, the **iPhone Duo**, launched on October 23, 2026. Slop
Hero was built for the Tesla in-car touchscreen, but the Duo's open inner
display is a big touchscreen too, so it makes a good second target. This doc
covers what the game does on the Duo, how it works, how to test it, and what's
worth building next. The decision record is
[ADR-0007](./adr/0007-foldable-iphone-duo-support.md).

## The device, as far as the web is concerned

| | Folded (outer screen) | Open (inner screen) |
|---|---|---|
| Panel | 5.4" OLED, 1398 × 2034, 460 ppi | 7.6" OLED, 1878 × 2670, 430 ppi |
| CSS viewport (3×) | ~466 × 678, portrait | ~890 × 626, wider than tall |
| Hinge | — | vertical, down the middle (~x = 445) |
| Refresh | 120 Hz ProMotion | 120 Hz ProMotion |

- **Safari identifies it as a plain iPhone.** The User-Agent can't tell a Duo
  from any other iPhone, so we never sniff for it. Everything keys off the
  viewport and the fold APIs.
- **Poses:** closed, open flat, half-folded like a book (vertical hinge), and
  tabletop or tent when rotated. The inner screen uses *regular* size classes
  like an iPad, so it can also run Safari in **Split View** (~445 px wide).
- **Fold APIs:** the Device Posture API (`(device-posture: folded)`) and the
  Viewport Segments API (`window.viewport.segments`, `env(viewport-segment-*)`)
  have shipped in Chrome since version 138. Reports differ on Safari. Some
  secondary sources say Safari 27.1 has both behind a feature flag; others say
  Safari exposes no fold signal at all. Neither is confirmed in WebKit release
  notes. The design below works either way.
- The viewport numbers are derived from the 3× panel specs. Safari's toolbars
  take some of the height, so measure `innerWidth`/`innerHeight` on a real
  device before relying on exact numbers.

## What the game does

1. **Folded (outer screen, ~466 × 678).** A normal phone in portrait. The
   existing small-screen rules apply: the HUD scales down and the song title
   hides.
2. **Open flat (~890 × 626).** Landscape like the Tesla screen, but shorter.
   A new short-screen rule (`max-height: 560px`) shrinks the header and HUD to
   give the highway more room. Splash and results cards now scroll instead of
   being clipped, since the results card is taller than the stage here.
3. **Half-folded, book posture.** The highway moves entirely onto one half of
   the screen (the trailing/right half by default), so notes never bend across
   the hinge. The score panel and calibration move to the other half.
   Ready/pause/results cards sit over the highway half, not across the fold.
4. **Tabletop posture** (rotated, horizontal hinge). The highway goes on the
   bottom half, which rests flat under your hands. The HUD goes on the top
   half, which faces you.
5. **Auto-pause on screen change.** Folding, unfolding, rotating, changing
   posture, or entering Split View mid-song moves every lane out from under
   your fingers, so the song pauses with a "your screen changed shape" message.
   Height-only changes, like Safari's toolbar collapsing, are ignored.
6. **Silent switch.** On every iPhone, not just the Duo, Web Audio is muted by
   the Ring/Silent switch. Uploaded and built-in songs now request the
   `playback` audio session (`navigator.audioSession`), so the song plays like
   a music app. Silent/demo mode returns to `auto`. YouTube mode is unaffected:
   its iframe isn't muted by the switch.
7. **No long-press side effects.** Holding a sustain is a long-press. The play
   screen now disables iOS text selection, the callout menu, and the tap
   highlight, so a hold can't pop a loupe or menu mid-song.

### How the split is decided

`src/lib/foldable.ts` is pure and unit-tested in `foldable.test.ts`.
`src/hooks/useFoldLayout.ts` feeds it live values:

```
viewport segments ──┐  (≥2 reported → use them)
                    ├─► segments ─► splitForSegments(segments, stageRect) ─► single | book | tabletop
device posture ─────┘  (folded but <2 segments → synthesizeSegments heuristic)
```

- **The heuristic is deliberately narrow.** It only guesses a centered
  vertical hinge when the posture is `folded` and the viewport is at least 760
  px wide with an aspect ratio of 1.2 or more. That means the whole open inner
  screen in landscape. It never guesses for the outer screen, portrait, or
  Split View. A wrong guess would run the fold through the highway, which is
  worse than not splitting.
- **Small halves fall back to one surface.** If either half is too small for
  a playable highway (under 240 px on a side), the layout stays `single`.
- **Taps follow the pane.** Touch input maps through the canvas's own bounding
  rect, so moving the highway into a pane needs no input changes.

## Testing

- **Unit tests:** `npm test` covers the split and form-change rules with Duo
  viewports in `src/lib/foldable.test.ts`.
- **Chromium (DevTools or Playwright):** set the viewport to 466 × 678 and
  890 × 626. To emulate book posture, use the CDP command
  `Emulation.setDevicePostureOverride` with `{ posture: { type: "folded" } }`
  on an 890 × 626 viewport. To exercise real segments, stub `window.viewport`
  with two `DOMRect`s in an init script.
- **Safari:** Xcode 27.1 ships an iPhone Duo simulator that can open, close,
  fold, and rotate. Enable the Device Posture and Viewport Segments flags under
  *Develop → Feature Flags* to try the API path. The simulator can't do
  multi-touch, so check chords and holds on hardware.
- **On a device, check:** fold or unfold mid-song (it should auto-pause), the
  silent switch on (an uploaded song should still play), holding a sustain for
  2 seconds or more (no loupe or callout should appear), and the Results card
  on the open screen (it should scroll and its buttons should be reachable).

## Suggested improvements

These come from the device research above and the foldable-design guidance it
surfaced. They're ordered by value for effort, highest first.

1. **Keep the screen awake during songs.** Call the Screen Wake Lock API
   (`navigator.wakeLock.request("screen")`) on Start and release it on
   pause/finish. Sparse sections and long holds can otherwise hit the iPhone
   auto-lock. This is a small change.
2. **Add a home-screen web app manifest.** iPhone Safari has no Fullscreen
   API, so the toolbars cost about 60 px of an already short 626 px landscape
   screen. A manifest with `display: "fullscreen"` (or `standalone`) plus
   `appleWebApp` metadata lets players install the game and play without
   browser chrome. This is a small change.
3. **Calibrate for Bluetooth latency.** AirPods add 150–250 ms of output
   latency, which the ±10 ms nudge buttons can't reasonably cover. Two
   options: a tap-along calibration screen (tap 8 beats, take the median
   offset), and/or seeding the offset from `AudioContext.outputLatency` where
   it's available. This is a medium change, and it helps every platform.
4. **Add a "swap sides" control for book posture.** The highway goes on the
   right half by default. Left-handed players, or players holding the Duo the
   other way, should be able to flip it. `splitForSegments` already takes
   `highwaySide`, so this just needs a persisted toggle in the HUD pane. This
   is a small change.
5. **Add a two-player split screen on the open display.** At ~445 × 570, each
   half of the open inner screen fits one playable highway. Two players, one
   per side, playing the same chart is a local duel that suits a device called
   "Duo". It needs the game hook to run two score states against one clock.
   This is a large change.
6. **Add a tabletop "fret pad" mode.** Rock Band-style: in tabletop posture,
   show the highway on the upright top half and five big fret pads on the flat
   bottom half, instead of tapping notes on the highway itself. This is closer
   to a real guitar controller. It's a medium-to-large change.
7. **Allow full device pixel ratio on 3× screens.** The canvas caps the DPR at
   2 for performance. The A20 Pro can likely handle 3× at 120 Hz, so measure
   frame times and raise the cap on capable devices for crisper gems. This is
   a small change, but it needs profiling.
8. **Use container queries for the HUD.** Viewport breakpoints (`max-width:
   720px`) misfire on foldables: the open screen hits tablet rules, while
   Split View and the folded screen hit phone rules. Sizing the score and
   calibration panels with container queries on their pane would let them fit
   whatever space they get. This is a medium change.
9. **Add an automated foldable smoke test.** A Playwright test at the three
   Duo widths (466, 890, 445) with posture emulation would catch layout
   regressions in CI. Chromium is already available in CI images. This is a
   medium change.
10. **Watch for the Safari APIs to unflag.** Once WebKit ships viewport
    segments for real, the heuristic only runs on older Safari. Revisit
    `synthesizeSegments` then, and consider deleting it.

**Not possible from the web today:** driving the outer and inner displays at
the same time (for example, a spectator view on the outer screen), haptics
(iOS Safari has no Vibration API), and reading the hinge angle.

## Sources

- [MacRumors — iPhone Duo roundup](https://www.macrumors.com/roundup/iphone-duo/)
  (displays, dimensions, poses, release)
- [webmobilefirst — iPhone Duo viewport](https://www.webmobilefirst.com/en/devices/apple-iphone-duo-folded-2026/)
  (CSS viewport + DPR)
- [QA.tech — testing on iPhone Duo](https://qa.tech/blog/how-to-test-your-website-on-iphone-duo)
  (Split View widths, simulator, common bugs)
- [DEV — Safari still can't tell you it folded](https://dev.to/keishin_nishiura/apple-shipped-a-foldable-iphone-safari-still-cant-tell-you-it-folded-565a)
  (Safari API status, resize-driven layout)
- [stork.ai — CSS fold APIs](https://www.stork.ai/blog/apples-2k-phone-hides-a-css-secret)
  (posture query, flagged Safari 27.1 support)
- [Chrome — Foldable APIs](https://developer.chrome.com/blog/foldable-apis-ot)
  (Device Posture + Viewport Segments)
- [Medium — iPhone Duo Layouts 101](https://medium.com/@prajwal/iphone-duo-layouts-101-stop-designing-for-six-poses-start-designing-for-space-539692f3f3bc)
  (book posture: alerts on the trailing side; tabletop: glanceable top,
  touch bottom)
