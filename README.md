# busy-dual-timer

Two countdowns on a [BUSY Bar](https://busy.bar), switched with the dial.

Timer **A** for work, timer **B** for a break. Click the dial to switch between
them; each one remembers where it was. Turn the dial to set the time without
touching a config file.

```
 A                                          B
   ██  ██  ██████   ████            ████   ██████    ████
   ██████     ██   ██  ██   ->     ██  ██  ██       ██  ██
   ██  ██    ██    ██  ██          ██  ██  ██████   ██  ██
   ████     ██      ████            ████   ██████    ████
 ████████████████████░░░░░░        ██████████████████░░░░
```

Nothing is installed on the Bar. This runs on any machine on the same network
and drives the device over its local HTTP API, so there is no firmware to
flash and nothing to undo — stop the program and the Bar goes back to normal.

**Zero runtime dependencies.** Node and nothing else.

---

## Controls

| Control | Action |
| --- | --- |
| **START** | start / pause |
| **Dial click** | switch between timer A and B |
| **Dial double-click** | reset the current timer |
| **Dial turn** | ±1 minute |
| **Dial hold + turn** | ±5 seconds |

**BACK does nothing, deliberately.** The Bar's firmware uses it to navigate its
own UI, which throws this widget off the screen. See
[Why BACK is unbound](#why-back-is-unbound).

**Switching stops the clock.** Two defined behaviours, not accidents:

- **The timer you leave is banked** at whatever was left on it, so you can flip
  back and forth without losing your place.
- **Neither timer runs after a switch.** Press START to begin the new one.

That second one is deliberate. Switching is how you change what you're doing, so
starting a countdown you didn't ask for would be quietly wrong — you'd be timing
a break against a clock you never started. It also means the two timers can
never both be draining, so time is never charged to the wrong one.

---

## Requirements

- **Node 22 or newer** (`node --version`). Nothing else — no npm packages are
  needed at runtime.
- A **BUSY Bar** with its local HTTP API enabled (below).
- A machine on the same network as the Bar, or connected to it by USB.
- Optional: `ffmpeg`, only if you want a custom sound in a compressed format.

---

## Setup

### 1. Enable the Bar's local HTTP API

Wi-Fi access is **off by default**, for good reason. Per the
[official instructions](https://docs.busy.app/bar/dev/http-api):

1. Connect the Bar to a computer by USB.
2. Open <http://10.0.4.20/> in a browser — that's the Bar's own web interface.
3. Go to the **Network** tab.
4. Under **HTTP API**, click **set password and enable**, and choose a password.

That password is your API token. Over USB no token is needed at all.

### 2. Find your Bar's address

**Over USB** it is always `10.0.4.20`. This needs no setup and no token, so it's
the easiest way to try things first.

**Over Wi-Fi**, on the device: **Settings → Wi-Fi → [your network] → View IP
Address**.

Check it answers:

```bash
curl http://10.0.4.20/api/version
# {"api_semver":"25.0.0"}
```

### 3. Install and configure

```bash
git clone <this-repo>
cd busy-dual-timer
npm install          # dev-only: typescript + @types/node
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "device": { "host": "10.0.4.20", "apiToken": null }
}
```

Over Wi-Fi, use your Bar's IP and the password you set:

```json
{
  "device": { "host": "192.0.2.42", "apiToken": "your-password" }
}
```

`config.json` is gitignored, so your address and token stay out of version
control.

### 4. Run it

```bash
npm test             # offline checks; no device needed
npm run dev
```

You should see:

```
[bar] 10.0.4.20 firmware API 25.0.0
[sound] uploaded chime.wav (47628 bytes) to app 'dual_timer'
[stream] connected
[ready] A=25:00 B=05:00 — start start/pause · dial click switches · ...
```

and the timer on the Bar's front display. Press START.

`Ctrl-C` clears the display and hands the screen back to the device.

---

## Configuration

Every key is optional — your `config.json` is merged over the defaults, so you
only write what you want to change.

### Timers — lengths, labels and colours

```json
"timers": [
  { "label": "A", "seconds": 1500, "color": "#3BA7FFFF" },
  { "label": "B", "seconds": 300,  "color": "#33D17AFF" }
]
```

Colours are `#RRGGBBAA` — eight digits, alpha included. The label is drawn in
the top-left corner; short is better on a 72×16 panel.

These are starting values. Turning the dial changes a timer's length while the
program runs, but does **not** rewrite this file — restart and you're back to
these numbers.

### Controls

```json
"gestures": {
  "toggleButton": "start",
  "switchButton": "ok",
  "resetButton": null,
  "doubleTapMs": 300,
  "coarseStepSeconds": 60,
  "fineStepSeconds": 5,
  "maxSeconds": 86400
}
```

| Key | Meaning |
| --- | --- |
| `toggleButton` | button for start/pause — `start`, `ok` or `back` |
| `switchButton` | button that switches timers; `ok` **is** the dial click |
| `resetButton` | optional extra reset button. `null` by default — [see below](#why-back-is-unbound) |
| `doubleTapMs` | two dial clicks within this are a reset, not two switches |
| `coarseStepSeconds` | step for a plain dial turn |
| `fineStepSeconds` | step for a turn with the dial held |
| `maxSeconds` | most the dial can wind a timer to |

The three button bindings must all be different. Lower `doubleTapMs` makes
switching feel snappier at the cost of needing a faster double-click; measured
rapid clicks run 147–182 ms apart, so much below ~220 ms gets hard to hit.

### Behaviour

```json
"behavior": {
  "resetOnSwitch": false,
  "autoAdvanceOnExpiry": false,
  "startPaused": true,
  "streamFrames": true,
  "reassertEveryMs": 2000,
  "maxEventsPerMessage": 8
}
```

| Key | Meaning |
| --- | --- |
| `resetOnSwitch` | switching refills the timer you leave instead of banking it |
| `autoAdvanceOnExpiry` | when A finishes, start B automatically |
| `startPaused` | wait for a press rather than starting on launch |
| `reassertEveryMs` | redraw this often to reclaim the screen if the device takes it |
| `maxEventsPerMessage` | drop suspiciously large input bursts ([why](#robustness)) |

### Expiry — flash and sound

```json
"expiry": {
  "flashSeconds": 10,
  "flashHz": 3,
  "ledColor": "#FF3B30FF",
  "sound": { "mode": "asset", "file": "chime.wav", "repeat": 3, "repeatEveryMs": 1200 }
}
```

With no sound file present, a chime is synthesised at startup — there's nothing
to install. To use your own, drop a file in `assets/`:

```bash
cp ~/Music/ding.mp3 assets/chime.wav
```

MP3, FLAC, OGG, M4A and AIFF need `ffmpeg` installed; WAV in any bit depth or
sample rate is handled with no external tools. **[Full guide, including
troubleshooting →](docs/custom-sounds.md)**

Set `"mode": "none"` for a silent flash, or use one of the device's own sounds
with `"mode": "stock", "stockPath": "shared/volume_change.snd"`.

---

## Running it as a service

To keep the timer up on an always-on machine, `busy-dual-timer.service` is a
systemd template:

```bash
npm run build
sudo cp -r . /opt/busy-dual-timer
sudo cp busy-dual-timer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now busy-dual-timer
journalctl -u busy-dual-timer -f
```

Edit `User=` and `WorkingDirectory=` in the unit file first.

---

## Things worth knowing about the hardware

Some of this is not in the official docs, and cost real time to find. The full
set is in **[docs/busy-bar-api.md](docs/busy-bar-api.md)**, with each claim
marked verified or inferred.

### Why BACK is unbound

The firmware acts on every button press regardless of what you have drawn, and
**you cannot suppress it**. For START and the dial that's harmless. BACK pops
the device's own navigation stack, which throws the widget off the panel — it
looks exactly like the program crashed, though it's still running perfectly.

Worse, it's contextual: at the root of the device's UI, BACK does nothing. So it
presents as an intermittent fault.

Reset therefore lives on a dial double-click. You *can* set
`"resetButton": "back"`, but that is opting into the above.

### The widget re-asserts itself

Nothing tells you when the device takes the screen, and a paused timer's drawing
never changes, so the widget would simply stay gone. It redraws every
`reassertEveryMs` regardless, reclaiming the panel within a couple of seconds.
Anything drawing a persistent widget on this hardware needs to do this.

### Audio: `200 OK` means nothing

`POST /api/audio/play` returns `200 {"result":"OK"}` for files **that do not
exist**. It never returns the `404` its own spec documents. The only way to
verify audio is for a person to listen to the Bar. Don't trust the status code —
it cost this project a wrong "verified" entry.

### Robustness

The countdown never touches the network, so packet loss or a disconnect cannot
make a timer drift — the display just stops updating until the link returns.

Beyond that: intervals between inputs are measured with the **device's own
clock**, not arrival time, because a stalled link delivers buffered events
together and two clicks arriving at once would otherwise look like a
double-click and silently reset your timer. Durations use a monotonic clock, so
an NTP step on the host can't corrupt a running timer. And the device has been
seen replaying a large batch of historical input at once, so oversized bursts
are dropped rather than firing dozens of actions.

---

## Development

```bash
npm test           # offline smoke test, incl. real captured device frames
npm run dev        # run from source (Node strips types natively)
npm run typecheck  # tsc --noEmit
npm run build      # -> dist/
```

| File | Role |
| --- | --- |
| `src/config.ts` | load, merge and validate config |
| `src/proto.ts` | minimal protobuf reader for the status WebSocket |
| `src/api.ts` | HTTP client + reconnecting WebSocket |
| `src/gestures.ts` | buttons and dial → timer actions |
| `src/timers.ts` | the two-countdown state machine (pure) |
| `src/render.ts` | 72×16 layout → draw payload (pure) |
| `src/audio.ts` | WAV → device PCM (pure) |
| `src/audio-file.ts` | file loading and ffmpeg |
| `src/chime.ts` | synthesised fallback chime |
| `src/clock.ts` | monotonic clock |
| `src/index.ts` | wiring, tick loop, expiry |

`timers.ts`, `render.ts` and `audio.ts` are deliberately pure, which is what
makes the offline test suite meaningful — it covers the protobuf decoder against
real captured frames, the gesture mapping, timer banking, layout bounds and
audio conversion, all with no hardware.

**[docs/architecture.md](docs/architecture.md)** explains why each piece is
shaped the way it is. **[docs/verification.md](docs/verification.md)** records
what has actually been proven on hardware, and what hasn't.

---

## Links

- [BUSY Bar documentation](https://docs.busy.app/)
- [HTTP API guide](https://docs.busy.app/bar/dev/http-api) — enabling it, tokens, connection types
- [HTTP API reference](https://api.busy.app/busybar/docs) — interactive
- [Official libraries](https://docs.busy.app/bar/dev/libraries) —
  [Python](https://github.com/busy-app/busylib-py) and
  [TypeScript](https://github.com/busy-app/busylib-ts)
- [Protobuf schemas](https://github.com/busy-app/busybar-protobuf)
- Your own Bar serves its spec at `http://<bar>/openapi.yaml` and rendered docs
  at `http://<bar>/docs/`

## License

MIT — see [LICENSE](LICENSE).
