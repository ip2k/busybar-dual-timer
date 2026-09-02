# Verification log

What has actually been proven, and how. Keep this honest — it is the difference
between "the docs say" and "the device does".

Device under test: BUSY Bar at `192.168.1.163`, firmware API `25.0.0`, local
HTTP API enabled with no auth token.

## Verified on hardware

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

- **A full run.** The program has never been started against the Bar and driven
  through a complete cycle. Every piece is proven; the assembly is not.
- **The gesture set on real hardware.** Tap / hold / triple-tap timings were
  derived from a capture, not exercised through `GestureRecognizer` live.
- **Audio.** The PCM format comes from busylib's ffmpeg arguments and the upload
  and playback calls have never been made against the device. This is the most
  likely thing to be wrong.
- **Expiry behaviour.** Flash, LED notification colour and chime repeat are
  untested end-to-end.
- **How the firmware reacts to the same presses.** Events reach us, but whether
  START also triggers device behaviour underneath the widget is unknown — and
  whether that matters depends on which switch position the Bar is in.
- **Long-run stability.** Reconnect logic, clock drift over hours, and whether
  the widget survives the device sleeping have not been observed.

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
