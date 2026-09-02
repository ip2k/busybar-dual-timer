# Architecture

## Shape of the thing

There is no on-device app model. The Bar exposes an HTTP API and a status
WebSocket; a widget is just a process somewhere on the network that reads
button events off the socket and pushes pixels back over HTTP. This program is
that process.

```
   BUSY Bar (192.168.1.163)
        |  ws://.../api/status/ws   -- protobuf State messages (input, frames, ...)
        v
   InputStream (api.ts) --> proto.ts --> InputEvent
        |
        v
   GestureRecognizer (gestures.ts)  -- press/release timing -> tap/hold/multi-tap
        |
        v
   DualTimer (timers.ts)            -- pure state machine
        |
        v
   render.ts                        -- snapshot -> draw payload
        |
        |  POST /api/display/draw
        v
   BUSY Bar front panel (72x16)
```

`index.ts` owns the tick loop (200 ms), expiry handling, and the decision of
when to actually issue a draw.

## Why each piece looks the way it does

### `proto.ts` — hand-rolled instead of protobufjs

The status stream carries a full front-display frame roughly once per second.
That is the overwhelming majority of the bytes, and we don't want any of it. A
general protobuf runtime would decode the whole `State` message including those
frames; walking the wire format ourselves lets us skip field 10 without ever
materialising it, and drops the dependency count to zero.

The trade is that we hand-maintain a decoder for a schema we don't own. It's
~150 lines covering four message types, pinned by tests against real captured
frames. If the schema grows in ways we care about, revisit — the schemas live
at https://github.com/busy-app/busybar-protobuf.

### `gestures.ts` — long press fires on threshold, not release

Short tap, long press and triple tap are not device concepts. The device gives
you PRESS and RELEASE; everything else is timing.

A long press fires the moment `longPressMs` elapses while the button is still
down, so the Bar reacts under your thumb rather than waiting for you to let go.
The release that follows is then swallowed so it doesn't also register as a tap.

Multi-tap is the awkward one: you cannot know a tap is a *single* tap until the
window closes. Hence two modes:

- `deferred` — wait out `multiTapWindowMs`, act on the final count. Correct, but
  start/pause lags ~400 ms.
- `immediate` — act on each tap as it lands. Tap 1 toggles, tap 2 toggles back,
  tap 3 resets. Identical end state, no latency, at the cost of the display
  flickering through intermediate states during a triple tap.

There is no third option that is both instant and unambiguous. If the latency
matters more than the flicker, or vice versa, that's a config change, not a
code change.

### `timers.ts` — banking, not two clocks

Only one timer runs at a time. Switching *banks* the active timer's remaining
time (`settle()`) and makes the other one current, so you can flip back and
forth without losing progress. A timer at zero is refilled when you land on it.

`checkExpiry()` returns `true` exactly once on the transition to zero, so the
caller can fire the alarm without edge-detection of its own.

The module has no I/O and no timers of its own — it's driven entirely by
`Date.now()` and the caller's tick. That's what makes it testable in
milliseconds rather than minutes.

### `render.ts` — text redraw rather than `countdown` elements

The firmware has a `countdown` element type that takes a target Unix timestamp
and ticks on-device, which would mean no per-second redraw at all. It was not
used because it exposes no font field, so the size and placement of the digits
would be out of our control on a 72×16 panel where every pixel is contested.

Instead the time is a plain `text` element redrawn when the rendered frame
actually changes — about once a second while running, never while paused. On a
LAN that's free. Revisit if network chattiness ever matters.

Draws are diffed by a cheap signature (`signature()`); the draw only goes out
when it differs from the last one. Because elements are keyed by `id` within an
application, a redraw replaces them in place — but when the element *set*
changes (the progress bar disappears, the flash rectangle appears) stale
elements must be cleared first, which `index.ts` handles by tracking the id set.

### `chime.ts` — synthesis instead of a shipped asset

The firmware wants headerless PCM (s16le, mono, 44.1 kHz). Producing that from
an mp3 needs ffmpeg; producing it from first principles needs about thirty
lines of arithmetic. The second option keeps the repo dependency-free and the
tarball small. A user-supplied `assets/chime.wav` takes precedence if present.

### Config: everything optional

`loadConfig` deep-merges the JSON file over a complete set of defaults, then
validates. A missing or partial `config.json` still runs. When adding a key,
touch the `Config` interface, `DEFAULTS`, and `validate()` together.

## Deliberate constraints

- **Zero runtime dependencies.** Node 22 gives us `fetch`, `WebSocket` and type
  stripping; nothing else is needed. This makes deployment a file copy.
- **No parameter properties, no `enum`.** Node's native type stripping rejects
  both, and `npm run dev` relies on it.
- **Pure core.** `timers.ts` and `render.ts` do no I/O, which is why the smoke
  test can cover the real logic without hardware.
