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

1. **Folded (outer screen, ~466 × 678).** A normal phone in portrait. The HUD
   scales down to fit the narrow highway and the song title hides.
2. **Open flat (~890 × 626).** Landscape like the Tesla screen, but shorter.
   The header and HUD shrink to give the highway more room. Splash and results
   cards scroll instead of being clipped, since the results card is taller
   than the stage here.
3. **Half-folded, book posture.** The highway moves entirely onto one half of
   the screen, so notes never bend across the hinge. The score panel and
   calibration move to the other half. Ready/pause/results cards sit over the
   highway half, not across the fold. **⇄ Swap sides** in the HUD half puts the
   highway on the other side (for left-handed players, or holding the Duo the
   other way); the choice is remembered on the device.
4. **Tabletop posture** (rotated, horizontal hinge). **Fret-pad mode** (the
   default): the highway stands on the upright top half (eyes up), and five
   big fret pads plus a ★ Star Power strip lie on the flat bottom half (hands
   down), like a Rock Band controller. The pads follow the highway's touch
   rules exactly: press to judge, slide between pads for hammer-ons, wiggle a
   held pad to whammy. **Tap highway instead** switches to the highway on the
   flat half with the HUD on top; **Use fret pads** switches back.
5. **Two players.** On a screen that can seat two highways (each half at least
   300 px; the open Duo, flat or book, Tesla, tablets), the ready card offers
   **2 players**: one song, two highways side by side (one per side of the
   hinge in book posture), each with its own score, combo, rock meter, and ★
   meter. Highest score wins; getting booed off forfeits. Versus runs aren't
   recorded in metrics or leaderboards.
6. **Auto-pause on screen change.** Folding, unfolding, rotating, changing
   posture, or entering Split View mid-song moves every lane out from under
   your fingers, so the song pauses with a "your screen changed shape" message.
   Height-only changes, like Safari's toolbar collapsing, are ignored.
7. **Silent switch.** On every iPhone, not just the Duo, Web Audio is muted by
   the Ring/Silent switch. Uploaded and built-in songs request the `playback`
   audio session (`navigator.audioSession`), so the song plays like a music
   app. Silent/demo mode returns to `auto`. YouTube mode is unaffected: its
   iframe isn't muted by the switch.
8. **No long-press side effects.** Holding a sustain is a long-press. The play
   screen disables iOS text selection, the callout menu, and the tap
   highlight, so a hold can't pop a loupe or menu mid-song.
9. **Screen stays awake** from the count-in to the last note (Screen Wake Lock
   API; re-requested when you come back to the tab).
10. **Bluetooth calibration.** A **tap test** (ready/pause cards and the
    calibration panel) plays a metronome through your headphones; you tap
    along and the median lag becomes the calibration. It's audio-only on
    purpose, so it measures the audio route rather than your eyes. In Chrome
    and Firefox, which report `AudioContext.outputLatency`, slow output
    (≥ 60 ms) seeds a starting value automatically. Safari doesn't report it.
    Calibration is saved on the device.
11. **Install to the home screen.** A web app manifest (`display:
    fullscreen`) and Apple web-app metadata let players install the game and
    play without Safari's toolbars (worth ~60 px on the open Duo). The landing
    page shows the Share → Add to Home Screen how-to on iOS, or an Install
    button where the browser supports it.
12. **Crisper on 3× screens.** The highway canvas renders at native density
    up to 3× (it was capped at 2×). If the median frame drops below 50 fps
    during a song, it steps down a notch (3 → 2 → 1.5 → 1), never back up.

### How the split is decided

`src/lib/foldable.ts` is pure and unit-tested in `foldable.test.ts`.
`src/hooks/useFoldLayout.ts` feeds it live values:

```
viewport segments ──┐  (≥2 reported → use them)
                    ├─► segments ─► splitForSegments ─► single | book | tabletop
device posture ─────┘  (folded but <2 segments → synthesizeSegments heuristic)

split + stage size + { fretPad, players } ─► stageLayout ─► highway pane(s), HUD pane, pads pane, modal pane
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
- **HUD sizing uses container queries.** The play stage, the highway pane,
  the HUD pane, and each card are CSS size containers, and the panels respond
  to the space they're actually given. Viewport breakpoints misfire on
  foldables: the open screen hits tablet rules, while Split View and the
  folded screen hit phone rules.

### Two players on one clock

Each player is a full `useRhythmGame` instance. Both drive the audio through
`src/lib/sharedTransport.ts`, which merges their simultaneous play requests
(both count-ins ending, both resuming) into one. It also only stops the song
once every active player has stopped, so the first player to finish, or to get
booed off, doesn't cut the music for the other. Solo play passes straight
through, so practice loops still re-seek normally.

## Testing

- **Unit tests:** `npm test` covers the split, stage layout, form-change, tap
  calibration, shared transport, versus, and render-scale rules
  (`src/lib/*.test.ts`, `src/game/calibration.test.ts`,
  `src/game/versus.test.ts`).
- **Browser smoke tests:** `npm run build && npm run test:e2e` runs
  `e2e/foldables.spec.ts` in Chromium at the Duo's three widths: the outer
  screen with auto-pause on unfold, the open screen with two players, book
  posture with swap sides, tabletop fret pads, and Split View. CI runs it as
  the **Foldable smoke (Playwright)** job.
- **Emulating postures by hand:** use the CDP command
  `Emulation.setDevicePostureOverride` with `{ posture: { type: "folded" } }`
  on an 890 × 626 viewport for book posture. For tabletop, stub
  `window.viewport` with two stacked `DOMRect`s in an init script.
- **Safari:** Xcode 27.1 ships an iPhone Duo simulator that can open, close,
  fold, and rotate. Enable the Device Posture and Viewport Segments flags under
  *Develop → Feature Flags* to try the API path. The simulator can't do
  multi-touch, so check chords, holds, fret pads, and two players on hardware.
- **On a device, check:** fold or unfold mid-song (it should auto-pause), the
  silent switch on (an uploaded song should still play), holding a sustain for
  2 seconds or more (no loupe or callout should appear), the tap test with
  AirPods (expect roughly −150 to −250 ms), and the screen staying on through a
  long quiet section.

## Follow-ups

The ten suggestions from the first round of research have shipped, except the
one that depends on Apple:

- **Watch for the Safari APIs to unflag.** Once WebKit ships viewport
  segments for real, the heuristic only runs on older Safari. Revisit
  `synthesizeSegments` then, and consider deleting it.

Ideas for later:

- **Remote/online versus.** The shared-clock design only covers one device.
- **A per-route calibration memory** (speakers vs. headphones). Browsers
  don't expose which output is active, so this would need the player to pick.
- **Haptic feedback** if iOS Safari ever gains the Vibration API.

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
