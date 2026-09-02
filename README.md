# busy-dual-timer

Two configurable countdowns on a BUSY Bar, driven entirely by one physical button.

| Gesture | Action |
| --- | --- |
| Short tap | Start / pause the active timer |
| Long press (default 700 ms) | Switch between timer **A** and timer **B** |
| Triple tap | Reset the active timer |

When a timer hits zero the front panel flashes in the timer's colour, the status
LED blinks, and a chime plays. Any button press dismisses it early.

## How it works

The Bar's local HTTP API is the whole interface — nothing runs on the device
itself.

- **Input.** `ws://<bar>/api/status/ws` streams protobuf `BSB_State.State`
  messages. Physical button presses arrive as `input.button_event`
  (`button` = OK / BACK / START, `action` = PRESS / RELEASE). Short tap, long
  press and triple tap are not device concepts — `src/gestures.ts` derives them
  from press→release timing.
- **Output.** `POST /api/display/draw` renders text and rectangles on the 72×16
  front matrix. Draws are accepted when their `priority` is at least that of the
  running system app: built-in apps sit at 10 and an active BUSY/CUSTOM session
  at 90, so the default priority of **95** keeps the timer on screen over both.
- **Sound.** The chime is synthesised at startup as raw 16-bit LE mono 44.1 kHz
  PCM, uploaded via `/api/assets/upload` and played with `/api/audio/play`.

Only 3 KB of `src/proto.ts` is needed to read the stream, so the project has no
runtime dependencies at all — just Node 22+.

## Setup

```bash
npm install          # typescript + @types/node, dev only
npm test             # offline checks, no device needed
npm run build && npm start
```

Or skip the build entirely — Node 22 strips the types itself:

```bash
npm run dev
```

Point `config.json` at your Bar first. Find its IP in the BUSY app, or on the
device under Settings → Wi-Fi.

## Configuration

`config.json` (all keys optional; anything missing falls back to a built-in
default):

```jsonc
{
  "device": {
    "host": "192.168.1.163",   // Bar's IP, or 10.0.4.20 over USB
    "apiToken": null           // required only if you enabled API auth
  },
  "app": {
    "name": "dual_timer",      // groups this widget's assets and draws
    "priority": 95             // 1-100; >90 to sit above a BUSY session
  },
  "timers": [
    { "label": "A", "seconds": 1500, "color": "#3BA7FFFF" },
    { "label": "B", "seconds": 300,  "color": "#33D17AFF" }
  ],
  "gestures": {
    "button": "start",         // "start" | "ok" | "back"
    "longPressMs": 700,
    "multiTapWindowMs": 400,
    "tapMode": "deferred",     // see below
    "resetTapCount": 3
  },
  "behavior": {
    "resetOnSwitch": false,    // true = leaving a timer resets it
    "autoAdvanceOnExpiry": false, // true = A finishes -> B starts (pomodoro)
    "streamFrames": true,
    "startPaused": true
  },
  "expiry": {
    "flashSeconds": 10,
    "flashHz": 3,
    "ledColor": "#FF3B30FF",
    "sound": {
      "mode": "asset",         // "asset" | "stock" | "none"
      "file": "chime.wav",     // drop your own in assets/ to replace it
      "stockPath": null,
      "repeat": 3,
      "repeatEveryMs": 1200
    }
  }
}
```

Colours are `#RRGGBBAA`.

### tapMode

Counting taps means a single tap can't be acted on until you know a second one
isn't coming.

- `deferred` (default) — wait out `multiTapWindowMs`, then act on the final
  count. Clean, but start/pause lags ~400 ms behind your thumb.
- `immediate` — act on every tap as it lands. Tap 1 toggles, tap 2 toggles
  back, tap 3 resets. Same end state, no latency, at the cost of the display
  flickering through the intermediate states during a triple tap.

### Custom chime

Drop any raw 16-bit LE mono 44.1 kHz PCM file at `assets/chime.wav`. To convert
from something else:

```bash
ffmpeg -i chime.mp3 -ar 44100 -ac 1 -f s16le -acodec pcm_s16le assets/chime.wav
```

Despite the `.wav` name the firmware wants headerless PCM — that is what
`-f s16le` produces, and what the app generates when no file is present.

## Running it as a service

`busy-dual-timer.service` is a ready systemd unit. On the box that should host
it:

```bash
sudo cp busy-dual-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now busy-dual-timer
journalctl -u busy-dual-timer -f
```

Edit `WorkingDirectory`, `User` and the `ExecStart` path in the unit first.

## Layout

```
src/config.ts     config load, merge over defaults, validation
src/proto.ts      minimal protobuf reader for the status stream
src/api.ts        HTTP client + reconnecting WebSocket
src/gestures.ts   press/release -> tap / long press / multi-tap
src/timers.ts     the two-countdown state machine
src/render.ts     72x16 layout -> draw payload
src/chime.ts      PCM chime synthesis
src/index.ts      wiring, tick loop, expiry handling
test/smoke.ts     offline checks, including real captured device frames
```

## Docs

- `CLAUDE.md` — orientation for Claude Code: hardware facts, commands, conventions, traps
- `docs/architecture.md` — why each module is shaped the way it is
- `docs/busy-bar-api.md` — API reference, marked verified vs. inferred
- `docs/verification.md` — what has actually been proven on hardware, and what hasn't
- `docs/roadmap.md` — where to pick up

## Notes and gotchas

- **proto3 default omission.** The first entry of a protobuf enum is its
  default, and proto3 omits defaults on the wire — so a press of **OK**
  (`button` 0, `action` 0) arrives as a completely empty `ButtonEvent`.
  `src/proto.ts` defaults both fields to 0 rather than treating an empty message
  as "no data". This bites anyone parsing the stream by hand.
- **The firmware still owns the buttons.** Events reach you regardless of what
  is on screen, but the device may also act on them itself. If a mode switch
  steals the screen, the next draw re-asserts the widget at its priority.
- The status WebSocket also carries a full front-display frame roughly once a
  second. The parser skips that field without decoding it; set
  `behavior.streamFrames` to `false` to ask the device not to send it, though
  the handshake has only been verified with it on.
- Redraws only fire when the rendered frame actually changes — about once a
  second while running, never while paused.
