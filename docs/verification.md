# Verification log

What has actually been proven, and how. Keep this honest — it is the difference
between "the docs say" and "the device does".

Device under test: BUSY Bar at `<bar-ip>`, firmware API `25.0.0`, local
HTTP API enabled with no auth token.

## Verified on hardware

### A full run, end to end (2026-09-02)

The assembled program was started against the Bar and driven through a complete
cycle. Run over **USB (`10.0.4.20`)** — see the note below about `<bar-ip>`.
Config was a scratch copy with `timers[0].seconds: 12`, `flashSeconds: 6`,
`sound.repeat: 2` so expiry came round quickly; `config.json` was not touched.

Startup, verbatim:

```
[bar] 10.0.4.20 firmware API 25.0.0
[sound] assets/chime.wav not found, using the built-in synthesised chime
[sound] uploaded chime.wav (47628 bytes) to app 'dual_timer'
[stream] connected
[ready] A=00:12 B=05:00 — tap start to start/pause, hold 700ms to switch, 3 taps to reset
```

Then, in order:

| Step | Result |
| --- | --- |
| `POST /api/input?key=start` | `[gesture] tap -> running` — synthetic press decoded off the WebSocket and drove the state machine |
| waited | `[expiry] timer A finished` at **12.078 s** after the tap |
| expiry audio | `POST /api/audio/play` returned OK — but see the correction below; this proved nothing |
| three rapid `POST /api/input` | `[gesture] multi-tap -> reset` — exactly one reset, no stray taps |
| `SIGINT` | `[shutdown] SIGINT`, display cleared, process exited 0 |

Over the whole run there were **zero** `[draw] failed` lines — the per-second
redraw at priority 95 held for the entire session.

**Correction — that run did not prove audio worked.** `POST /api/audio/play`
returns `{"result":"OK"}` even for files that do not exist, so the absence of an
error said nothing. Audio was later verified properly, by ear; see below.

### The rendered widget, read back off the panel

`GET /api/screen?display=0` (integer, not `front` — see `docs/busy-bar-api.md`)
returns a frame grab. Decoding one mid-run, with timer A running:

```
  2 ..#.....................................................................
  3 .#.#.....................####...####.....####...####....................
  4 .###....................#....#.#....#...#....#.#....#...................
 ...
 11 .........................####...####.....####...####....................
 15 #############################################...........................
```

The `A` label sits top-left in the tiny font, the time is large and centred, and
the progress bar occupies the bottom row — the layout `render.ts` intends. Every
lit pixel decoded to `3ba7ff`, exactly the configured `#3BA7FFFF` for timer A,
so colour survives the round trip intact.

This means layout changes can now be checked from a script instead of by eye.

### The gesture set, driven by a human thumb over Wi-Fi (2026-09-02)

The three gestures were exercised on real hardware, by hand, with the Bar on
Wi-Fi at `<bar-ip>` and the program running the **shipped `config.json`**
(A=25:00, B=5:00) — not a scratch copy. Latency 13–35 ms.

| Gesture | Log line | Notes |
| --- | --- | --- |
| single tap | `[gesture] tap -> running` | first real press to drive the assembled program |
| hold ≈2 s | `[gesture] hold -> timer B (05:00)` | **no trailing `tap`** — the release was swallowed, as designed |
| three quick taps | `[gesture] multi-tap -> reset` | exactly one reset, no stray `tap` first |

**The long press fires under the thumb.** Confirmed visually: the panel flipped
to B partway through an ~2 s hold, not on release. This is the behaviour
`gestures.ts` is built around — the threshold fires while the button is still
down and the release that follows is swallowed — and it is what makes the switch
feel responsive rather than laggy. It had never been observed before.

All three gestures behaved as intended, and no disruptive firmware behaviour was
seen underneath: the widget kept the screen throughout and each press did only
what the widget meant it to. (The switch position during this run was not
recorded, so a position-dependent interaction is not ruled out.)

The swallowed release and the single-reset-from-three-taps are the two things
most likely to go wrong with real finger timing, and both held. `longPressMs: 700`
is now **confirmed by feel** — it reads as deliberate without dragging, and
should be left alone. `multiTapWindowMs: 400` works but is untuned, and in
`deferred` mode it sets the start/pause lag directly; see `docs/roadmap.md`.

Frame grabs confirmed each state on the panel: after the hold the label read `B`
with `05:00` in `33d17a`, exactly the configured `#33D17AFF`, and the paused
progress bar rendered full-width in a dimmed green (`176138`).

Over the ~6 minute session: **0** draw failures, **0** stream disconnects, **0**
sound failures.

### Audio, verified by ear (2026-09-02)

The earlier "audio works" claim rested on an HTTP 200 and was wrong: the device
returns `200 {"result":"OK"}` for deliberately bogus paths, both `stock_path`
and `path`. It never returns the `404` its own spec documents.

Tested the only way that actually works — a person listening to the Bar. Played
the device's stock `shared/volume_change.snd` four times, then our uploaded
`chime.wav` four times. Both were **audible**, and the two were **distinct from
each other**, confirming that the second was our file and not a repeat of the
stock sound.

So the full audio path is real: `generateChime()` produces valid PCM, the upload
lands (confirmed independently at `/ext/user_assets/dual_timer/chime.wav`,
47628 bytes), and playback is audible. Device volume was 100.

The format is confirmed from a second direction too: the stock sounds are 44100
and 132300 bytes, exactly 0.5 s and 1.5 s of 16-bit mono 44.1 kHz.

**Lesson for this repo: never mark an output-producing endpoint verified on the
strength of its status code.**

### `ledMode: transitions` on hardware (2026-09-03)

Observed by watching the device:

- **Timer B started → the green LED flashed a few times, then stopped.** That is
  the firmware's `Notification` preset doing exactly what its source says: three
  blinks at maximum brightness, fired once per event rather than re-triggered by
  every redraw.
- **Expiry showed "B DONE" with a red LED.** Expiry deliberately uses
  `expiry.ledColor` (default `#FF3B30FF`) rather than the timer's own colour, so
  an alarm reads as an alarm whichever timer fired it. The per-timer colours are
  for telling A from B *while running*.

Together with the earlier `running` test — flashing light blue for A, flashing
neon green for B — both LED modes are now confirmed on hardware, and the
three-blink behaviour matches what the firmware source says it should be.

### Per-timer LED colours and distinct chimes, by eye and ear (2026-09-03)

Both confirmed on hardware by a person watching and listening.

**LED.** `timers[].ledColor` set to `#0080FFFF` for A and `#00FF40FF` for B, run
through paused/running phases:

| Phase | Observed |
| --- | --- |
| A paused | LED off |
| A running | **flashing light blue** |
| B running | **flashing neon green** |

So the colour is ours to choose, per timer, and it tracks the active timer.

**The LED flashes; it cannot be held steady.** That is the firmware's own
pattern and there is no field to change it — which settles the Morse idea. Dots
and dashes would have to be built from bursts of flashing, no finer than our
redraw interval. Documented as a limitation rather than half-built.

**Chimes.** A's and B's expiry sounds were confirmed audibly different — A rises,
B falls a fourth lower.

### The lever as an app switch, and the device left alone (2026-09-03)

With `behavior.activeSwitchPosition: "custom"`, verified by hand:

| Step | Result |
| --- | --- |
| startup, lever on CUSTOM but not yet seen | widget hidden, screen handed back — panel showed the device app (`ours=0`) |
| lever to APPS | stayed hidden, device app visible (383 px) |
| **on APPS**: START pressed, dial clicked ×3, dial rotated both ways, BACK used to navigate the clock view | **zero events reached this app**; the device behaved exactly as it does when the timer is not running |
| lever back to CUSTOM | `[input] switch -> custom (widget on)`, panel showed the timer (`ours=162`) |

The middle row is the important one. Hiding the widget alone would have left
presses quietly mutating timer state behind another app's UI. Input is dropped
before it reaches the recogniser, so running this does not change how the Bar
works when you are not using it.

Also confirmed: two distinct expiry sounds are uploaded, one per timer —
`chime.wav` (47628 bytes) and `chime-2.wav` (49392 bytes). Different lengths
because they are genuinely different tones, not the same file twice.

### The switch position decides whether BACK disturbs the widget (2026-09-03)

Same program, same build, identical probe run in two lever positions:

| Lever | Idle panel | After BACK |
| --- | --- | --- |
| **APPS** | ours | **device UI stole the screen** (ours=60, device=323), reclaimed ~2 s later |
| **CUSTOM** | ours | **untouched** — device=0 throughout |

Repeated on CUSTOM to be sure it was not luck: BACK pressed six times, sampled
0.4 s and 1.2 s after each. **Screen stolen 0/6**, device pixels zero every time.

This closes a question left open earlier — whether firmware button behaviour
varies with the switch. It does. On APPS there is a navigation stack for BACK to
pop; on CUSTOM there is not, so the press is inert. That contextual behaviour is
exactly why the fault first looked intermittent.

Practical upshot: **run a persistent widget with the lever on CUSTOM.** The
`reassertEveryMs` safety net still covers anything else that takes the panel.

### Expiry no longer strobes the device UI (2026-09-03)

Reported from use: the "DONE" screen flashed back and forth with the device's
calendar app. Reproduced from a captured frame sequence — during expiry the
panel alternated every ~300 ms:

```
16.25    82 lit  ours
16.56   374 lit  DEVICE UI   <- leak
16.87  1070 lit  ours (full-screen flash)
17.18   379 lit  DEVICE UI   <- leak
```

Cause was ours, not the device's. The flash emitted different element ids for
its lit and dark phases, and `render()` clears before drawing whenever the id
set changes; the firmware's screen is visible in that gap. At `flashHz: 3` the
gap opened six times a second.

Fixed by keeping the id set stable and painting the covering rectangle black on
the dark phase, and by defaulting `expiry.flashHz` to `0` so "DONE" simply holds.
Verified on hardware — 7+ seconds of expiry sampled at 350 ms, every frame ours,
no leaks:

```
 5.4s lit=1070 ours     ... 12.8s lit=1070 ours
```

The regression test was checked by reintroducing the old behaviour and
confirming the suite fails.

### The remapped control scheme, by hand (2026-09-03)

Confirmed on the device by a person using the physical controls: START
start/pause, dial click to switch, dial double-click to reset, dial turn for
minutes, dial held + turn for seconds. All behave as designed.

The 300 ms `doubleTapMs` window did not read as sluggish in use.

**Pause-on-switch was noticed in use before it was written down.** A running
timer stops when you switch — correct and desirable, but at the time it was an
emergent property of `settle()` plus the phase assignment, documented nowhere
and asserted by no test. It is now a stated guarantee in `timers.ts` with three
tests behind it, checked by deliberately breaking the behaviour and confirming
the suite fails.

### Sound conversion, verified by ear (2026-09-03)

The converter was exercised end to end on hardware, both paths:

| Source | Path | Uploaded |
| --- | --- | --- |
| stereo 48 kHz 16-bit WAV | in-process, no external tools | 132300 bytes |
| stereo 48 kHz 192 kbps MP3 | ffmpeg | 132300 bytes |

Both land on exactly 132300 bytes — 1.50 s of s16le mono 44.1 kHz, byte-for-byte
the same length as the device's own 1.5 s stock sounds. The upload was confirmed
present at `/ext/user_assets/dual_timer/chime.wav`.

Then the part that actually matters: **a person listened.** The converted sweep
played audibly on the Bar and was plainly a different sound from the synthesised
bell chime, confirming it was our file rather than a leftover. Following the rule
this project learned the hard way, no status code was treated as evidence.

Also verified incidentally: the WAV was written by ffmpeg to a file named
`chime.wav` but was a genuine RIFF WAV, and detection ignored the extension and
identified it by its magic bytes. The MP3 was detected as MP3 the same way.

### The firmware steals the screen, and we now take it back (2026-09-03)

Pressing BACK on the device threw the widget off the panel: a frame grab showed
the device's own clock/calendar screen in white and grey where our timer had
been. The widget did **not** come back on its own.

Two separate things, worth keeping apart:

1. **The firmware acted on the press.** BACK pops the device's navigation stack.
   This cannot be suppressed — trap 4 in `CLAUDE.md`. Its effect is contextual:
   pressing BACK again once the stack is at its root did nothing, so the
   disruption is intermittent rather than reliable.
2. **We never redrew.** This was our bug. `render()` skips the draw when the
   payload signature is unchanged, and a paused timer's signature is static, so
   once the screen was taken nothing ever reclaimed it.

Fixed by redrawing at least every `behavior.reassertEveryMs` (default 2000)
regardless of change. Verified on hardware:

| | Panel |
| --- | --- |
| immediately after BACK | device UI (`ffffff`, `7d7d7d`) |
| 4 s later | **our widget** (`3ba7ff`, `1b4d76`) |

Note the gesture itself was never the problem — `[gesture] back -> reset` fired
correctly throughout. Only the display was lost.

### Ramp thresholds were miscalibrated (2026-09-03)

First hardware use of the dial showed a deliberate spin runs **56–83 ms between
detents**, not the ~600 ms a casual spin had suggested. With `fastGapMs: 90`
that meant ordinary spinning immediately hit the ×5 multiplier — the timer went
2:04 → 17:04 in four detents. Retuned so ×5 needs a genuine flick (<25 ms) and
normal spinning lands on ×2.

A reminder that "measured" is not the same as "measured under the conditions
that matter": the earlier figure came from the dial being turned for a capture,
not from someone actually setting a timer.

### Encoder, dial click and switch (2026-09-02)

Captured off `/api/status/ws` with a raw byte dumper, by hand:

- **The dial rotation emits `EncoderEvent`**, exactly `±1` zigzag sint32 per
  detent. `proto.ts`'s inferred mapping was already correct.
- **The dial click is the `ok` button**, and it arrives as a completely empty
  `ButtonEvent` — the proto3 default-omission trap, observed live.
- **Rotation is delivered while the dial is held**, so click+spin is available
  as a modifier gesture.
- **Switch positions** decode correctly (`apps` = 3, `settings` = 4), and the
  `BUTTONS` ordering (`ok`, `back`, `start`) is now confirmed rather than
  assumed — `back` was seen for the first time.

Wire formats and measured human timings are in `docs/busy-bar-api.md`.

### Physical button events reach the API

A human tapped START three times and held it once, while a WebSocket client was
connected to `/api/status/ws`. All four gestures came through as
`input.button_event` updates:

| # | press → release | duration |
| --- | --- | --- |
| 1 | +0.00 s → +0.11 s | 107 ms |
| 2 | +1.13 s → +1.19 s | 68 ms |
| 3 | +2.17 s → +2.31 s | 141 ms |
| 4 | +3.18 s → +9.90 s | 6.7 s (deliberate hold) |

The Bar was on the **Apps** screen with the calendar app running at the time, so
input events are not gated on the screen being idle.

Raw frames from that session are fixtures in `test/smoke.ts` — the decoder is
tested against real bytes, not synthesised ones.

### Drawing over a running built-in app

`POST /api/display/draw` with the exact payload `render.ts` generates for
"timer A, 25:00, half elapsed" — a `tiny` label, a `large` time, and a
`rectangle` progress bar, at `priority: 95` — returned `200 {"result":"OK"}`
while the calendar app was on screen.

`DELETE /api/display/draw?application_name=dual_timer` then returned
`200 {"result":"OK"}`.

This confirms the element schema, the font names, the rectangle element, the
`#RRGGBBAA` colour format, and that priority 95 preempts a built-in app.

### Spec location and version

`GET /openapi.yaml` → 200, 88 KB. `GET /api/version` → `{"api_semver":"25.0.0"}`.
`/openapi.json`, `/docs/openapi.json`, `/swagger.json` all 404.

## Verified offline

`npm test` covers, with no hardware:

- decoding the real captured START press/release frames
- an unrelated update (a network-transport message) decoding to no events
  without throwing
- the proto3 empty-`ButtonEvent` case resolving to OK + PRESS
- three quick taps producing exactly one `reset`; a hold producing exactly one
  `longPress` with no trailing tap; a lone tap producing `{tap, count: 1}`
- timer start/pause/bank/switch-and-return/reset, and expiry firing exactly once
- duration formatting across `MM:SS` and `H:MM:SS`
- every rendered element landing inside the 72×16 panel, and the progress bar
  measuring 36 px at half elapsed
- the synthesised chime being well-formed 16-bit PCM

## Not yet verified

- **Long-run stability.** The longest observed run is minutes, over both USB and
  Wi-Fi, clean in both. Clock drift over hours, reconnect behaviour after a real
  network drop, and what happens when the device sleeps are all still unobserved.
- **Expiry with a real press to dismiss it.** Expiry, flash and chime have run to
  completion on their own timer; acknowledging one with a physical tap has not
  been tried.

## Connection note

Both paths are now proven:

- **Wi-Fi `<bar-ip>`** — works; this is what `config.json` ships with.
- **USB `10.0.4.20`** — works; useful when the Bar is tethered to the machine.

Earlier in testing `<bar-ip>` pinged but refused TCP 80 while the Bar was
on USB. That was the address not being served at the time, not a defect; once
the Bar was moved to Wi-Fi it answered there normally.

## How to verify the rest

`npm run dev` on a machine on the LAN, then:

1. Watch the log for `[stream] connected` and the firmware version line.
2. Confirm the widget appears on the front panel.
3. Tap START — the timer should start; the log prints `[gesture] tap`.
4. Hold START — should switch to timer B under your thumb, before release.
5. Triple-tap — should reset.
6. Set `timers[0].seconds` to something small (say 5) to exercise expiry, flash
   and chime without waiting.

`BusyBarClient.sendInput('start')` drives the same paths without the hardware
button, which is useful for scripted checks — though note it exercises the
firmware's input path, so it is a slightly different test than a real press.
