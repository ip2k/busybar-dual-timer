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

- **The long-press switch gesture.** `POST /api/input` sends a *single key
  press* — the spec has no duration and no separate press/release — so a hold
  cannot be synthesised. Switching A↔B is the one gesture that still needs a
  human thumb on the button.
- **Real physical presses through the assembled program.** Button events were
  captured from real presses earlier, and the gesture recogniser was driven by
  synthetic ones; the two halves have not been joined. Whether the firmware also
  acts on the same press underneath the widget remains open.
- **Long-run stability.** The longest run so far is minutes. Reconnect
  behaviour, clock drift over hours, and what happens when the device sleeps are
  all unobserved. One reconnect was seen at shutdown (`code 1005`), which is the
  expected close, not a fault.
- **The Bar over Wi-Fi.** This run went over USB; the LAN address did not serve
  HTTP (see below).

## Environment note: `192.168.1.163` is not currently serving the API

As of this run the configured host in `config.json` does not work:

- `192.168.1.163` — pings (57 ms, MAC `c:fa:22:0:53:36`) but TCP 80 refuses.
  The latency and the refusal suggest something else holds that address now.
- `10.0.4.20` (USB) — fully working: `api_semver 25.0.0`, `openapi.yaml` 88146 B.

`config.json` has been left pointing at `192.168.1.163`. Either re-check the
Bar's Wi-Fi address and update it, or run over USB with `BUSY_TIMER_CONFIG`
pointed at a config using `10.0.4.20`.

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
