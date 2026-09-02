# BUSY Bar HTTP API — working notes

Everything below marked **verified** was checked against a real device
(`192.168.1.163`, firmware API `25.0.0`). Everything else is from published docs
or library source and should be treated as unconfirmed.

Spec: `http://<bar>/openapi.yaml` — **not** `/openapi.json`, which 404s.
Rendered docs: `http://<bar>/docs/`. Public copy: `https://api.busy.app/busybar/docs`.

## Reading physical button presses — verified

`ws://<bar>/api/status/ws`. Send `{"enable": true}` as a text frame on open,
then decode binary frames as `BSB_State.State` protobuf.

Schemas: https://github.com/busy-app/busybar-protobuf

```proto
State       { fixed64 timestamp = 1; repeated StateUpdate updates = 2; Error error = 3 }
StateUpdate { oneof state { ... Frame frame = 10; InputEvent input = 11; Timer timer = 12; ... } }
InputEvent  { oneof event { ButtonEvent button_event = 1; SwitchEvent switch_event = 2; EncoderEvent encoder_event = 3 } }
ButtonEvent { Button button = 1; ButtonAction action = 2 }
EncoderEvent{ sint32 delta = 1 }

enum Button         { OK = 0; BACK = 1; START = 2 }
enum ButtonAction   { PRESS = 0; RELEASE = 1 }
enum SwitchPosition { BUSY = 0; CUSTOM = 1; OFF = 2; APPS = 3; SETTINGS = 4 }
```

Captured wire bytes from a real START tap:

```
5a 04 0a 02 08 02          input -> button_event -> button=START, action=PRESS (default, omitted)
5a 06 0a 04 08 02 10 01    input -> button_event -> button=START, action=RELEASE
```

Both are fixtures in `test/smoke.ts`.

**Events arrive while a built-in app owns the screen** — verified on the Apps
screen with the calendar app running. The firmware may also act on the same
press; custom gestures ride alongside device behaviour rather than replacing it.

Measured timings from a live test: deliberate taps at 68 / 107 / 141 ms, a
deliberate hold at 6.7 s. Comfortably separable.

### Trap: proto3 default omission

The first entry of a protobuf enum is its default and proto3 omits defaults on
the wire, so a press of **OK** (button 0, action 0) arrives as an entirely empty
`ButtonEvent`. Default both fields to 0; do not treat an empty message as "no
data". busylib-py hit the same thing (their issue #77).

### Trap: skipping length-delimited fields

`pos += readVarint()` is wrong in JS and Python — the old `pos` is read before
the varint call advances it past its own bytes. Read the length into a local
first.

## Drawing — verified

`POST /api/display/draw`, JSON body:

```json
{
  "application_name": "dual_timer",
  "priority": 95,
  "led_notification_color": "#FF3B30FF",
  "elements": [ ... ]
}
```

Verified: accepted with `200 OK` at priority 95 over a running built-in app,
and `DELETE /api/display/draw?application_name=dual_timer` cleared it.

- Front display 72×16 RGB; back 160×80 greyscale (16 levels).
- Element types: `text`, `image`, `animation`, `countdown`, `rectangle`.
- Common fields: `id`, `type`, `x`, `y`, `display` (`front`/`back`), `align`
  (`top_left`…`bottom_right`, `center`), and either `timeout` (seconds, 0 = never)
  or `display_until` (Unix seconds) — mutually exclusive.
- `text`: `text`, `font`, `color`, optional `width` + `scroll_rate`,
  `scroll_start_delay`, `scroll_repeat_delay`.
  Fonts: `tiny`, `small`, `normal`, `condensed`, `bold`, `large`, `extra_large`,
  `global`. **Printable ASCII only** — the fonts are bitmap ASCII.
- `rectangle`: `width`, `height`, `radius`, `fill`
  (`none`/`solid`/`gradient_h`/`gradient_v`), `fill_colors[]`, `border_width`,
  `border_color`.
- `countdown`: `timestamp` (Unix seconds, as a *string*), `color`, `direction`
  (`time_left`/`time_since`), `show_hours` (`when_non_zero`/`always`). Ticks
  on-device — no per-second redraw needed. **No font field.**
- `image`: `path` (an uploaded asset) or `stock_path` (device artwork),
  plus `opacity`.
- Colours are `#RRGGBBAA`.
- Elements are keyed by `id` within an `application_name`, so redrawing the same
  ids replaces them. There is no `clear_before_draw` in the raw HTTP API —
  busylib implements that as clear-then-draw.

### Priority — the important bit

A draw is accepted when its priority is **>=** the priority of the currently
running system app. Equal-priority draws from a *different* `application_name`
override what's on screen.

| What | Priority |
| --- | --- |
| stub / poweroff apps | 0 — always preemptable |
| any standard built-in app | 10 |
| active BUSY / CUSTOM work session | 90 |
| accepted API range | 1–100 (0 reserved internally) |

95 keeps a custom widget above everything, BUSY sessions included.

## Audio

The firmware plays **raw PCM: signed 16-bit little-endian, mono, 44.1 kHz**,
uploaded under a `.wav` filename — headerless, despite the extension. This is
what busylib's ffmpeg conversion targets:

```bash
ffmpeg -i in.mp3 -ar 44100 -ac 1 -f s16le -acodec pcm_s16le out.wav
```

1. `POST /api/assets/upload?application_name=X&file=chime.wav`
   with `Content-Type: application/octet-stream`
2. `POST /api/audio/play` — `{application_name, path}` or
   `{application_name, stock_path}`
3. `DELETE /api/audio/play` stops playback
4. `DELETE /api/assets/upload?application_name=X` removes an app's assets

Stock audio names are **unknown** — see open questions below.

## Endpoint inventory

From the live spec. Unless noted, these are listed but untested here.

| Path | Methods | Notes |
| --- | --- | --- |
| `/api/status/ws` | GET (upgrade) | **verified** — state + input stream |
| `/api/display/draw` | POST, DELETE | **verified** — draw / clear |
| `/api/assets/upload` | POST, DELETE | **verified** — headerless PCM upload accepted |
| `/api/audio/play` | POST, DELETE | **verified** — plays an uploaded app asset |
| `/api/audio/volume` | GET, POST | |
| `/api/display/brightness` | GET, POST | value or `auto` |
| `/api/input` | POST | **verified** — simulates a key press; see below |
| `/api/busy/snapshot` | GET, PUT | built-in BUSY timer state |
| `/api/busy/profiles/{slot}` | GET, PUT | built-in timer profiles |
| `/api/screen` | GET | **verified** — single frame grab; see below |
| `/api/version` | GET | **verified** — `{"api_semver":"25.0.0"}` |
| `/api/status`, `/api/status/{device,firmware,system,power}` | GET | |
| `/api/storage/{write,read,list,remove,mkdir,rename,status}` | | `list` returned 400 with `?path=` |
| `/api/time`, `/api/time/{timestamp,timezone,tzlist}` | | |
| `/api/name`, `/api/access` | GET, POST | device name; Wi-Fi API access config |
| `/api/wifi/{status,connect,disconnect,networks}` | | |
| `/api/ble/{enable,disable,pairing,status}` | | |
| `/api/smart_home/{pairing,switch}` | | Matter |
| `/api/account`, `/api/account/{link,info,status,backend}` | | cloud/MQTT |
| `/api/update`, `/api/update/{check,status,changelog,install,abort_download,autoupdate}` | | |
| `/api/log_dump` | POST | |
| `/api/transport` | GET | network connection info |

### `/api/input` is not the input stream

`POST /api/input?key=<up|down|ok|back|start|busy|custom|off|apps|settings>`
*simulates* a press — it is what the phone app uses as a remote. Reading real
presses is the WebSocket. `BusyBarClient.sendInput()` wraps it; handy for
driving the widget without touching the hardware.

### `GET /api/screen` — frame grab (verified)

`GET /api/screen?display=<0|1>` — `display` is an **integer**, `0` = front,
`1` = back. `?display=front` is what returns 400.

The response is `Content-Type: image/bmp`, but it is **not a BMP** — there is no
BMP header. It is **base64 text** whose decoded bytes are raw, bottom-padded
pixel data in **BGR order**, one byte per channel, no row padding:

| | front (`display=0`) |
| --- | --- |
| Response body | 4608 base64 characters |
| Decoded | 3456 bytes = 72 × 16 × 3 |
| Layout | row-major from the top-left, 3 bytes/pixel |
| Channel order | **B, G, R** — a drawn `#3BA7FF` reads back as `3b a7 ff` reversed, i.e. bytes `ff a7 3b` |

So a drawn colour round-trips exactly, provided you swap the byte order. This
was checked by drawing timer A (`#3BA7FFFF`) and reading the frame back: every
lit pixel decoded to `3ba7ff` after the swap.

This closes the loop for scripted visual checks — the widget layout (tiny label
top-left, large centred time, progress bar on the bottom row) was confirmed from
a frame grab rather than by eye.

### Audio: `200 OK` proves nothing — you must listen

`POST /api/audio/play` returns `{"result":"OK"}` with HTTP 200 for files that
**do not exist**:

```
{"application_name":"dual_timer","stock_path":"shared/this_does_not_exist.snd"}  -> 200 {"result":"OK"}
{"application_name":"dual_timer","path":"nope_not_real.wav"}                     -> 200 {"result":"OK"}
```

The spec documents a `404` for "Audio file not found or is unplayable". The
device never sends it. So the response is an acknowledgement that the request
was accepted, not evidence that a sound was produced — **the only way to verify
audio is for a person to listen to the Bar.** An earlier version of this project
recorded audio as "verified" on the strength of a 200; that was wrong.

Verified properly, by ear: both a stock sound and our uploaded, synthesised
headerless-PCM chime are **audible and distinct from one another**.

### Stock assets and storage layout (verified)

`GET /api/storage/list?path=...` requires a path matching `^/ext(/...)*$` — it
must start with `/ext`. `?path=/` returns 400, which is what made this look
broken before.

| Path | Contents |
| --- | --- |
| `/ext` | `apps_assets`, `user_assets`, `apps_data`, `update`, `Manifest` |
| `/ext/apps_assets/shared/sounds` | the stock sounds |
| `/ext/apps_assets/shared/` | also `animations`, `fonts`, `images`, `ca` |
| `/ext/user_assets/<app_name>` | assets uploaded by your app |

The stock sounds, which answers the long-open "stock asset names" question:

| File | Size | Duration at s16le mono 44.1 kHz |
| --- | --- | --- |
| `volume_change.snd` | 44100 | exactly 0.5 s |
| `calendar_event_starts.snd` | 132300 | exactly 1.5 s |
| `calendar_reminder_ends.snd` | 132300 | exactly 1.5 s |

Those sizes are *exact* multiples for 16-bit mono at 44.1 kHz, which
independently **confirms the audio format** rather than inferring it from
busylib's ffmpeg arguments. Play one with
`{"application_name":"<app>","stock_path":"shared/volume_change.snd"}`.

An asset uploaded by this app shows up at `/ext/user_assets/dual_timer/` — handy
for confirming an upload actually landed, since the upload response is as
uninformative as the playback one.

### Encoder, switch and button wire formats (verified)

All three input kinds were captured off `/api/status/ws` with a raw dumper, so
these are observed bytes rather than inference. `StateUpdate.input` is field
**11** (`0x5a`), and inside `InputEvent` the oneof tags are `button_event` = 1,
`switch_event` = 2, `encoder_event` = 3 — exactly as `proto.ts` assumed.

| Input | Bytes after the `fixed64` timestamp | Decodes to |
| --- | --- | --- |
| dial, one detent left | `12 06 5a 04 1a 02 08 01` | `encoder delta -1` |
| dial, one detent right | `12 06 5a 04 1a 02 08 02` | `encoder delta +1` |
| START press | `12 06 5a 04 0a 02 08 02` | `button start, press` |
| START release | `12 08 5a 06 0a 04 08 02 10 01` | `button start, release` |
| BACK press | `12 06 5a 04 0a 02 08 01` | `button back, press` |
| switch → settings | `12 06 5a 04 12 02 08 04` | `switch settings` |
| switch → apps | `12 06 5a 04 12 02 08 03` | `switch apps` |

**The dial works and the existing decoder was already right.** Each detent emits
one `EncoderEvent` with a **zigzag sint32** delta of exactly `±1` — it does not
accumulate or send larger steps when spun fast. Turning it several clicks
produces several separate events, one per detent, roughly 0.6 s apart at a
casual spin rate.

This also confirms the `BUTTONS` ordering (`ok`, `back`, `start` = 0, 1, 2) —
previously only `start` and `ok` had been seen — and the `SWITCH_POSITIONS`
ordering, where `apps` = 3 and `settings` = 4.

Note the proto3 default omission in action: a START *press* carries no `action`
field at all (`08 02` is the button, action 0 is omitted), while the *release*
carries `10 01`. This is the trap documented in `CLAUDE.md`, visible on the wire.

### The dial click is the `ok` button — and it composes with rotation

Pressing the dial in emits `button ok`. That accounts for `ok` on hardware with
no obvious separate OK button, and it means the dial is **two** inputs: a
rotation and a button.

```
12 04 5a 02 0a 00           ok press    <- note: ButtonEvent is EMPTY
12 06 5a 04 0a 02 10 01     ok release
```

The press is the proto3 trap from `CLAUDE.md` in its purest form, now observed
on the wire: button `ok` is 0 and action `press` is 0, both are defaults, so
proto3 omits **both** and `ButtonEvent` arrives zero-length (`0a 00`). A decoder
that treats an empty message as "no data" silently loses every dial click. The
release carries `10 01` because action 1 is not a default.

**Rotation is reported while the dial is held down.** Captured click → spin →
release:

```
21.026s  ok press
21.622s  encoder +1     <- 11 detents, all delivered during the hold
  ...
22.958s  encoder +1
23.567s  ok release
```

So press-and-spin is a usable modifier gesture — coarse vs fine adjustment, or
"hold to change the other timer" — without any conflict between the two streams.

### Measured input timings

Real human timings, captured rather than assumed. Useful for setting gesture
windows:

| | |
| --- | --- |
| Rapid click, press → press | **147–182 ms** |
| Rapid click, release → next press | **81–92 ms** |
| Click duration | 66–90 ms |
| Casual spin, detent → detent | ~600 ms |
| Fast spin, detent → detent | as low as **15 ms** |

Two consequences. `multiTapWindowMs: 400` has roughly **2× margin** over a real
rapid multi-click at ~180 ms press-to-press, so it can come down meaningfully.
And a fast spin can emit detents 15 ms apart, so anything driven by the encoder
wants rate-limiting rather than a redraw per event.

### Input events can arrive in a batch on connect (observed once)

On one connection the **first** message was 1691 bytes and decoded to a burst of
~28 encoder events, an `ok` press/release, a switch event and ~40 `start`
press/release pairs — historical input, delivered all at once at connect time.

A fresh connection made minutes later, with the device untouched, showed **no**
such batch, and the recent real presses were *not* replayed. So this is not a
simple "replay everything since boot", and the trigger is not understood.

It matters because `InputStream` reconnects automatically. If a batch like that
arrives after a reconnect, `GestureRecognizer` would see dozens of press/release
pairs back to back and could fire spurious taps or resets. Nothing of the sort
has been seen in normal running, and it has not recurred — but a reconnect that
suddenly resets someone's timer would be very confusing, so it is worth
knowing about. Guarding would mean ignoring input that arrives implausibly soon
after `onOpen`, or discarding a batch above some size.

### Auth

`X-API-Token` header for local access when a token is set; the WebSocket takes
it as an `?x-api-token=` query parameter instead. This Bar currently has no
token. Status streaming is **local only** — the cloud API refuses the upgrade.

## Connection methods

The same API is reachable over USB Ethernet (`10.0.4.20`), Wi-Fi LAN (assigned
IP), and the cloud (`https://api.busy.app/busybar`, token auth, no WebSocket).
No code changes between them beyond the base URL.

## Open questions

- **`{"enable": false}` on the WebSocket.** With `false` the socket goes
  completely silent — not even the 1 Hz timestamp heartbeat arrives. Whether it
  still delivers *input* events is **still unknown**: the one capture made with
  `false` happened to have no button presses in it, so the silence proves
  nothing either way. Re-test with a deliberate press before trusting
  `behavior.streamFrames: false`.
- **`/api/busy/*`.** The built-in BUSY timer already has profile slots. Driving
  those instead of rendering our own display was never explored and might give
  a more native-feeling result.

## Libraries

- Python: `pip install busylib` — https://github.com/busy-app/busylib-py
  (docs: https://busy-app.github.io/busylib-py/) — the most complete reference,
  and its source documents several firmware quirks.
- TypeScript: `@busy-app/busy-lib` — https://github.com/busy-app/busylib-ts.
  Its state stream runs through a Web Worker, which is awkward under plain Node;
  that's why this project talks to the API directly.
- Firmware source: https://github.com/busy-app/busybar-firmware
- Protobuf schemas: https://github.com/busy-app/busybar-protobuf
