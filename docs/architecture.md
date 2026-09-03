# Architecture

## Shape of the thing

There is no on-device app model. The Bar exposes an HTTP API and a status
WebSocket; a widget is just a process somewhere on the network that reads
button events off the socket and pushes pixels back over HTTP. This program is
that process.

```
   BUSY Bar (<bar-ip>)
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

### `gestures.ts` — one control, one job

The device gives you PRESS and RELEASE on three buttons, plus a dial that
reports rotation as `±1` per detent. Everything else is our interpretation.

| Control | Action |
| --- | --- |
| START | start / pause |
| dial click | switch A ↔ B |
| dial double-click | reset |
| dial turn | adjust by `coarseStepSeconds` (default 60 s) |
| dial click + turn | adjust by `fineStepSeconds` (default 5 s) |

**BACK is deliberately unbound.** See below — it is not ours to use.

START acts on the press, with nothing to wait for, because start/pause is the
one action where latency is actually felt. The dial carries everything else.

A dial click has to wait out `doubleTapMs` (default 300 ms) to know whether a
second click is coming, so switching costs that much latency. That is a
deliberate trade: switching happens far less often than start/pause, and paying
it is what keeps reset off BACK.

Turning while the dial is held gives fine steps and suppresses the click on
release, so click-and-spin doesn't also flip timers.

**There is no speed ramping.** An earlier version multiplied the step when the
dial spun fast. It was tried on hardware and removed: it felt unpredictable, and
for the timers people actually set, one detent per minute is plenty. The
measurements are kept in `docs/busy-bar-api.md` in case anyone wants to
reconsider.

### BACK belongs to the firmware, not to us

The firmware acts on every button press regardless of what we draw, and this
cannot be suppressed. For START and the dial that is harmless. For BACK it is
not: **BACK pops the device's own navigation stack**, which throws the widget
off the panel and leaves the device UI showing.

This was found the hard way — reset was originally bound to BACK, and pressing
it looked like the app had crashed. It hadn't; the gesture fired correctly every
time and the process was fine. Only the display was lost.

The effect is contextual, which makes it more confusing rather than less. At the
root of the device's navigation stack BACK does nothing — and, more usefully,
**the physical lever decides whether there is a stack at all.** Measured across
six presses in each position: on APPS the screen is stolen reliably, on CUSTOM
it was not stolen once. Running with the lever on CUSTOM avoids the problem
rather than recovering from it.

Two consequences, and both matter:

1. **Reset lives on a dial double-click.** `gestures.resetButton` still exists
   and can be pointed at BACK, but it defaults to `null`. Binding it is opting
   in to the behaviour above.
2. **The widget re-asserts itself.** Nothing tells us the screen was taken, and
   a paused timer's draw signature never changes, so without help the widget
   would stay gone indefinitely. `behavior.reassertEveryMs` (default 2000)
   redraws regardless of change, and priority 95 reclaims the panel. This
   protects against anything that takes the screen, not just BACK.

### Draw elements are keyed by id, and that has teeth

A draw is a set of elements with ids. When the ids change between frames, stale
ones would linger, so `index.ts` clears first and then draws. **Between those two
calls the firmware's own screen is visible.**

That cost a real bug. The expiry flash originally emitted a full-screen
rectangle plus text when lit, and text alone when dark. Different id sets, so
every blink forced a clear — and at `flashHz` the alarm strobed between "DONE"
and the device's clock/calendar screen several times a second. It looked like a
rendering fault on the device; it was ours.

The rule that falls out: **change an element's colour, never its existence.** The
expiry flash now always draws the rectangle and simply paints it black on the
dark phase, which keeps the id set stable (no clear, no gap) and covers the
device UI even if a redraw is slow. A test asserts both phases emit the same ids
and that both cover the full panel.

The paused blink never had this problem because it only ever varied a colour's
alpha — which is exactly the pattern to copy.

By default the expiry does not blink at all: `expiry.flashHz` is `0`, holding
"DONE" steady. A finished timer wants to be readable, and a 72×16 panel strobing
across a desk is more irritating than informative. Set it above zero to bring
the flash back.

### The lever as an app switch

`behavior.activeSwitchPosition` makes the physical lever choose between the
device's own apps and this timer. It is off by default; set to `"custom"` the
widget appears only in that position.

Two halves, and the second matters more than it looks:

1. **The display is taken down** when the lever moves away — an explicit clear,
   not just skipped drawing, so the device's own app is visible again.
2. **Input is ignored.** Button and dial events are dropped before they reach
   the recogniser. Merely hiding the widget would leave presses quietly mutating
   timer state behind another app's UI, and the timer would jump inexplicably
   when you came back. Running this must not change how the Bar behaves when you
   are not using it.

Switch events themselves are always processed — they are how we learn the lever
moved. A half-finished press is discarded when the lever leaves, so a press
begun in one position cannot complete in another.

Timers keep counting while hidden. Hiding is about the screen, not the clock.

**The awkward part:** the lever position is only reported when it *changes*.
Nothing exposes the current position — `/api/status` and `/api/busy/snapshot`
were both checked. So at startup the position is unknown, and the widget stays
hidden until the lever moves once, even if it is already in the right place.
Hidden is the correct default for an unknown state: covering an app someone is
using is worse than making them flick a switch, and the startup log says exactly
what it is waiting for.

### Behaviour on a laggy or spotty network

The countdown itself never touches the network. `timers.ts` is driven by a local
clock, so packet loss, a stalled socket or a full disconnect cannot make a timer
drift, pause or skip — the display just stops updating until the link is back.
That is the single most important property here, and it comes free from keeping
`timers.ts` pure.

Three things did need explicit care:

**Never measure an interval with arrival time.** Dial ramping keys off the gap
between detents. If that gap is measured locally, a Wi-Fi stall that releases
three buffered detents at once makes them look 5 ms apart, ramps to the largest
multiplier and jumps the timer by a wild amount. Every `State` message carries
the device's own clock, so `parseState` returns it and the ramp uses that
instead. A gap that goes backwards — clock step, or events out of order — is
treated as "no ramp" rather than trusted, so the failure direction is a step
that is too small rather than too large.

**Bursts are treated as replays, not input.** The device has been seen
delivering ~70 historical input events in one message. Under the current mapping
every press acts immediately, so that backlog would fire dozens of toggles and
resets. A single message carrying more than `behavior.maxEventsPerMessage`
events (default 8) is dropped with a warning. In normal use each input arrives
in its own message, and a human cannot produce eight in one 1 Hz window.

**Durations use a monotonic clock, not wall time.** `clock.ts` wraps
`performance.now()`. Wall-clock time is not monotonic — NTP will step it, and a
long-running service host will do that eventually. A backwards step mid-countdown
makes a timer gain time; a forwards step makes it lose time or expire instantly.
Wall time is still used where it has to match the outside world: log lines, and
comparing against the device's own timestamps.

Two supporting details: every HTTP call carries a 5 s `AbortSignal.timeout`, so a
hung request cannot wedge the draw loop, and the draw path holds a single
in-flight guard so a slow network drops frames rather than queueing them.

### `timers.ts` — banking, not two clocks

Only one timer runs at a time. Switching *banks* the active timer's remaining
time (`settle()`) and makes the other one current, so you can flip back and
forth without losing progress. A timer at zero is refilled when you land on it.

**Switching also stops the clock, and that is a contract rather than a side
effect.** `switchTimer` never leaves the phase `running`: the outgoing timer is
settled and the incoming one lands on `idle` or `paused`. Starting a countdown
the user did not ask for is silently wrong — they would be timing a break
against a clock they never started — and requiring a press to resume is what
makes it impossible for both timers to drain at once, so time can never be
attributed to the wrong one.

It would be easy to lose this in a refactor, since it emerges from two separate
lines. There are tests that a running timer stops on switch, that the timer you
switch *to* does not auto-start, and that returning to the first one does not
resume it.

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
