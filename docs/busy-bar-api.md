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
| `/api/assets/upload` | POST, DELETE | upload / delete app assets |
| `/api/audio/play` | POST, DELETE | play / stop |
| `/api/audio/volume` | GET, POST | |
| `/api/display/brightness` | GET, POST | value or `auto` |
| `/api/input` | POST | **simulates** a key press — see below |
| `/api/busy/snapshot` | GET, PUT | built-in BUSY timer state |
| `/api/busy/profiles/{slot}` | GET, PUT | built-in timer profiles |
| `/api/screen` | GET | single frame grab; returned 400 in testing |
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

### Auth

`X-API-Token` header for local access when a token is set; the WebSocket takes
it as an `?x-api-token=` query parameter instead. This Bar currently has no
token. Status streaming is **local only** — the cloud API refuses the upgrade.

## Connection methods

The same API is reachable over USB Ethernet (`10.0.4.20`), Wi-Fi LAN (assigned
IP), and the cloud (`https://api.busy.app/busybar`, token auth, no WebSocket).
No code changes between them beyond the base URL.

## Open questions

- **Stock asset names.** `GET /api/storage/list?path=/` returns 400 — the query
  parameter name is wrong or listing works differently. Without it, `stock_path`
  values for images and sounds are unknown.
- **`GET /api/screen`.** Returned 400 with `?display=front`. The TypeScript
  library types it as `display` being `Front = 0` / `Back = 1`, so it may want a
  numeric value. Worth resolving — it would allow visually verifying a rendered
  frame from a script.
- **`{"enable": false}` on the WebSocket.** Only `true` has been tested. If it
  suppresses the once-a-second frame updates while still delivering input
  events, that's a worthwhile bandwidth win (`behavior.streamFrames`).
- **`/api/busy/*`.** The built-in BUSY timer already has profile slots. Driving
  those instead of rendering our own display was never explored and might give
  a more native-feeling result.
- **Encoder and switch events.** Decoded by `proto.ts` but never seen on the
  wire during testing, so the field mappings are unconfirmed.

## Libraries

- Python: `pip install busylib` — https://github.com/busy-app/busylib-py
  (docs: https://busy-app.github.io/busylib-py/) — the most complete reference,
  and its source documents several firmware quirks.
- TypeScript: `@busy-app/busy-lib` — https://github.com/busy-app/busylib-ts.
  Its state stream runs through a Web Worker, which is awkward under plain Node;
  that's why this project talks to the API directly.
- Firmware source: https://github.com/busy-app/busybar-firmware
- Protobuf schemas: https://github.com/busy-app/busybar-protobuf
