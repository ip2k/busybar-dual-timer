# Verification log

What has actually been proven, and how. Keep this honest — it is the difference
between "the docs say" and "the device does".

Device under test: BUSY Bar at `192.168.1.163`, firmware API `25.0.0`, local
HTTP API enabled with no auth token.

## Verified on hardware

### A full run, end to end (2026-09-02)

The assembled program was started against the Bar and driven through a complete
cycle. Run over **USB (`10.0.4.20`)** — see the note below about `192.168.1.163`.
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
| expiry audio | **no** `[sound] playback failed` — `POST /api/audio/play` returned OK for both repeats |
| three rapid `POST /api/input` | `[gesture] multi-tap -> reset` — exactly one reset, no stray taps |
| `SIGINT` | `[shutdown] SIGINT`, display cleared, process exited 0 |

Over the whole run there were **zero** `[draw] failed` lines — the per-second
redraw at priority 95 held for the entire session.

**Audio now works.** This was flagged as the most likely thing to be wrong. Both
halves are proven: the headerless-PCM upload is accepted, and playback of an
uploaded app asset returns OK. The synthesised chime was used (no `chime.wav`
in `assets/`), so `generateChime()` produces something the firmware accepts.

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
Wi-Fi at `192.168.1.163` and the program running the **shipped `config.json`**
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
- **Firmware behaviour underneath the widget, per switch position.** No
  interference was seen during the by-hand run — every press did only what the
  widget intended — but the switch position was not recorded at the time, so
  whether some position changes what START does natively is still open.
- **Expiry with a real press to dismiss it.** Expiry, flash and chime have run to
  completion on their own timer; acknowledging one with a physical tap has not
  been tried.

## Connection note

Both paths are now proven:

- **Wi-Fi `192.168.1.163`** — works; this is what `config.json` ships with.
- **USB `10.0.4.20`** — works; useful when the Bar is tethered to the machine.

Earlier in testing `192.168.1.163` pinged but refused TCP 80 while the Bar was
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
