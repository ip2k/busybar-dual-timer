# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`busy-dual-timer` — two configurable countdowns on a BUSY Bar. START =
start/pause, dial click = switch A/B, dial double-click = reset, dial turn =
adjust minutes, dial held + turn = adjust seconds. BACK is deliberately unbound. Everything runs off-device against the Bar's
local HTTP API; nothing is installed on the Bar itself.

Status: **working, and driven through a full cycle against real hardware**
(2026-09-02) over both USB and Wi-Fi — startup, input stream, gestures by hand,
expiry, audio (verified by ear), draw and clean shutdown all proven, with no
draw failures or stream drops across a 35-minute soak. The remapped START /
dial control scheme was **re-verified by hand on firmware 1.2.3 (2026-09-09)**,
in the same run that confirmed the `node:http` transport fix. See
`docs/verification.md` for exactly what has and hasn't been proven, and
`docs/roadmap.md` for what's next.

## The hardware

| | |
| --- | --- |
| Device | BUSY Bar — `10.0.4.20` over USB, or its DHCP address on Wi-Fi |
| Firmware API | `27.5.0` (firmware 1.2.3) |
| Local HTTP API | must be enabled on the device; Wi-Fi needs a token, USB does not |
| OpenAPI spec | `http://<bar>/openapi.yaml` (**not** `/openapi.json` — 404s) |
| Rendered docs | `http://<bar>/docs/` |
| Front display | 72×16 RGB LED matrix |
| Back display | 160×80 greyscale, 16 levels |

The bundled `busy-dual-timer.service` is a template for running this as a
systemd service on any always-on Linux box on the same network.

The working device address lives in `config.json`, which is **gitignored** —
this is a public repo, so keep real addresses and tokens out of tracked files.

**The Bar is live on the network.** You can hit it directly with `curl` from a
machine on the LAN, and you should — the device is the source of truth, and the
published docs are incomplete in places. Draws are trivially reversible
(`DELETE /api/display/draw?application_name=dual_timer`), so experimenting on
the display is cheap. Be more careful with anything under `/api/wifi`,
`/api/update`, `/api/account` or `/api/time`.

## Commands

```bash
npm install         # typescript + @types/node — dev only, zero runtime deps
npm test            # offline smoke test; no device needed, run this first
npm run dev         # run from source (Node 22 strips types natively)
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm run typecheck   # tsc --noEmit
```

`npm test` is fast, needs no hardware, and covers the protobuf decoder against
real captured device frames. Run it after touching anything in `src/`.

## Architecture

```
src/config.ts     load config.json, deep-merge over defaults, validate
src/proto.ts      minimal protobuf reader for the status WebSocket
src/api.ts        HTTP client + reconnecting WebSocket
src/gestures.ts   buttons + dial -> toggle / switch / reset / adjust
src/clock.ts      monotonic clock for measuring durations
src/timers.ts     the two-countdown state machine (pure, no I/O)
src/render.ts     72x16 layout -> draw payload (pure, no I/O)
src/chime.ts      PCM chime synthesis
src/index.ts      wiring, tick loop, expiry handling
test/smoke.ts     offline checks incl. real captured frames
```

`timers.ts` and `render.ts` are deliberately pure — no network, no clock beyond
`Date.now()`, no side effects. Keep them that way; they are what makes the
smoke test meaningful. I/O belongs in `api.ts` and orchestration in `index.ts`.

`docs/architecture.md` explains why each piece is shaped the way it is.

## Conventions

- **Node 22+, ESM, TypeScript, strict mode.** No runtime dependencies — this is
  a deliberate constraint, not an accident. Don't add one without a real reason;
  the whole protobuf need is ~150 lines.
- **No TypeScript parameter properties and no `enum`.** Node's native type
  stripping (`--experimental-strip-types`, used by `npm run dev`) rejects both.
  Write explicit fields and assign in the constructor; use `as const` unions
  instead of enums. This is easy to violate by accident.
- Relative imports carry the `.ts` extension; `tsc` rewrites them on build via
  `rewriteRelativeImportExtensions`.
- Colours are `#RRGGBBAA` throughout, validated in `config.ts`.
- Config keys are all optional — `loadConfig` deep-merges the file over
  built-in defaults, so a partial `config.json` works. Add new keys to *all
  three* of the `Config` interface, the `DEFAULTS` object and the `SHAPE`
  table (which is what flags typos), and validate them with the typed helpers
  (`num`, `str`, `bool`, `oneOf`) — never a bare `> 0`, which coerces strings.

## Traps that have already cost time

1. **proto3 default omission.** The first entry of a protobuf enum *is* its
   default, and proto3 omits defaults on the wire. A press of **OK** (button 0,
   action 0) arrives as a completely empty `ButtonEvent`. Both fields must
   default to 0 rather than treating an empty message as "no data". Covered by a
   test — don't "simplify" it away.
2. **`pos += readVarint()` is a bug in JS.** The old `pos` is read before
   `readVarint()` advances it past its own bytes. Read the length into a local
   first. See the comment in `src/proto.ts`.
3. **Draw priority.** A draw is accepted only when its priority is `>=` the
   running system app's. Built-in apps = 10, an active BUSY/CUSTOM session = 90.
   Default here is 95 so the widget sits above both. If draws silently stop
   landing, check this first.
4. **The firmware still owns the buttons.** Input events reach you regardless of
   what's on screen (verified with a built-in app running), but the device
   *also* acts on the same press, and you cannot suppress that. **BACK pops the
   device's navigation stack**, which throws the widget off screen — observed on
   hardware. Its effect is contextual: at the root of the stack it does nothing,
   so this is intermittent rather than reliable.

   Crucially, nothing tells you the screen was taken, and a paused timer's draw
   signature never changes, so the widget stays gone. `behavior.reassertEveryMs`
   exists for exactly this: redraw periodically regardless of change, and
   priority 95 reclaims the panel within a couple of seconds.

   **It is position-dependent, and CUSTOM is the safe one.** Measured: on APPS
   BACK steals the screen reliably; on CUSTOM it did not once in six presses,
   because there is no navigation stack to pop. Test on APPS if you want to see
   the failure; run on CUSTOM if you want it not to happen.
5. **Audio is headerless PCM despite the `.wav` name** — s16le, mono, 44.1 kHz.
   A real WAV file with a RIFF header is not what the firmware wants. Confirmed
   twice over: audible by ear, and the stock sounds are exactly 0.5 s / 1.5 s at
   that format.
6. **`POST /api/audio/play` returns `200 {"result":"OK"}` for files that do not
   exist**, and never the `404` its spec documents. Still true on 1.2.3. It
   *does* return `404 {"error":"Failed to play audio"}` for a file that exists
   but is empty — so it checks what it decodes, not what it opens. Either way
   the status code is worthless as evidence — audio can only be verified by a
   person listening. Do not mark it verified any other way.
7. **`GET /api/storage/list` needs a path starting with `/ext`.** `?path=/`
   returns 400. Stock sounds live in `/ext/apps_assets/shared/sounds`; this app's
   uploads land in `/ext/user_assets/dual_timer/`.
8. **`/api/openapi.json` does not exist.** It's `/openapi.yaml` at the root.
9. **`/api/screen` wants an integer.** `?display=0` (front) / `1` (back), not
   `front`. Despite the `image/bmp` content type the body is **base64 text** of
   raw 72×16 **BGR** pixels — no BMP header. Swap the byte order or your colours
   come back reversed. This is how to check a layout without eyeballing the panel.
10. **Never measure the gap between inputs with local arrival time.** On a laggy
   network a stall delivers buffered events all at once and they look
   simultaneous. Use the device's own `State.timestamp` (Unix ms, in every
   message) — that's what `parseState` returns it for.
11. **Changing the set of element ids forces a clear, and a clear shows the
   device UI.** `render()` clears before drawing when the id set changes, and
   between the clear and the draw the firmware's own screen is visible. The
   expiry flash used to emit different ids for its lit and dark phases, so the
   alarm strobed between "DONE" and the device's clock screen several times a
   second. Keep an element present and change its colour instead of adding and
   removing it. Covered by a test.
12. **The stream can deliver a big backlog of input in one message.** Observed
   once: ~70 historical events at connect. Acting on it would fire dozens of
   toggles and resets, so `behavior.maxEventsPerMessage` drops oversized bursts.

13. **The Bar pads `Content-Length`, and that breaks `fetch()`.** A 24-byte
   body is announced as `Content-Length: 24` followed by **nine spaces** — the
   firmware `printf`s the header into a fixed-width field. RFC 7230 permits
   trailing whitespace after a field value, and curl, `node:http` and Python
   all strip it. `fetch()` does not: undici reports the header as `24` but its
   own end-of-message accounting disagrees, aborts the body mid-read, and
   throws a bare `TypeError: terminated`. Every call to the device fails, on
   the first byte of the first response.

   This is why `src/api.ts` is built on `node:http` and not `fetch`. Do not
   "modernise" it back. There is a test that serves the device's exact bytes,
   padding included; it fails within seconds if the transport is swapped.

   It is **undici specifically**, not `fetch` everywhere: Chromium's `fetch`,
   Deno's, curl and Python all read the padded header correctly — all tested.
   Don't repeat the claim that browsers are affected; they are not.

   Two smaller lessons came with it. Leading whitespace is fine and trailing is
   not, so the header *looks* well-formed in every debugger. And the error said
   only `terminated` because the failing call — `response.json()` — sat one
   line outside the `try` that would have unwrapped its `cause`. Read bodies
   inside the same error boundary as the request.

14. **Never send the Bar a chunked request body.** `node:http` uses chunked
   transfer-encoding whenever `Content-Length` is not set, and the firmware
   does not read a chunked body. It does not fail: `POST /api/assets/upload`
   answers `{"result":"OK"}` and writes a **zero-byte file**. The upload log
   line says "uploaded chime.wav (47628 bytes)" because that is what we sent,
   not what landed.

   Nothing goes wrong for several minutes. Then a timer expires and
   `POST /api/audio/play` returns `404 {"error":"Failed to play audio"}`, three
   times, and the alarm is silent. `GET /api/storage/list` is the only way to
   see the truth — check the **size**, not the presence.

   Within the same boot, the zero-byte file cannot be overwritten: a later
   upload to the same name returns `508 {"error":"Failed to open file for
   writing"}` — a handle is evidently left open. After a device restart the
   same upload overwrites it cleanly. `DELETE /api/storage/remove?path=/ext/...`
   is the delete endpoint, but one such delete on a zero-byte file wedged the
   HTTP server until a power cycle (once; not reproduced). Prefer restarting
   the Bar to deleting.

   `api.ts` now sets `Content-Length` on every request that has a body, and a
   test asserts uploads are neither chunked nor missing the header. This one
   cost an hour of a soak run and was found only because the sound failure was
   logged rather than swallowed — keep logging failures that don't stop the app.

## Working style for this repo

- Prefer verifying against the live Bar over trusting the docs. Several
  published details were wrong or absent; every claim in `docs/busy-bar-api.md`
  marked *verified* was checked against the device.
- When you learn something new about the API, add it to `docs/busy-bar-api.md`
  and mark whether it's verified or inferred.
- Keep `docs/verification.md` honest — it's the record of what's actually been
  proven on hardware. Don't upgrade something to "verified" without running it.
