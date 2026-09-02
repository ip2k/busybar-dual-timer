# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

`busy-dual-timer` — two configurable countdowns on a BUSY Bar, driven by one
physical button. Tap = start/pause, long press = switch timer A/B, triple tap =
reset. Everything runs off-device against the Bar's local HTTP API; nothing is
installed on the Bar itself.

Status: **working, and driven through a full cycle against real hardware**
(2026-09-02) — startup, input stream, tap, multi-tap reset, expiry, audio,
draw and clean shutdown all proven. The long-press A/B switch is the one
gesture still unexercised: `POST /api/input` sends a single press with no
duration, so a hold needs a real thumb. See `docs/verification.md` for exactly
what has and hasn't been proven, and `docs/roadmap.md` for what's next.

## The hardware

| | |
| --- | --- |
| Device | BUSY Bar, `192.168.1.163` on the LAN (`10.0.4.20` over USB) |
| Firmware API | `25.0.0` |
| Local HTTP API | enabled, **no auth token** currently |
| OpenAPI spec | `http://192.168.1.163/openapi.yaml` (**not** `/openapi.json` — 404s) |
| Rendered docs | `http://192.168.1.163/docs/` |
| Front display | 72×16 RGB LED matrix |
| Back display | 160×80 greyscale, 16 levels |

There is also an Ubuntu box on the same network at `192.168.1.25` (user
`likwid`, has sudo) — the intended host if this is ever run as a service. The
bundled `busy-dual-timer.service` is already pointed at it.

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
src/gestures.ts   press/release -> tap / long press / multi-tap
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
  built-in defaults, so a partial `config.json` works. Add new keys to *both*
  the `Config` interface and the `DEFAULTS` object, and validate them.

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
   what's on screen (verified with a built-in app running), but the device may
   *also* act on the same press. Custom gestures ride alongside device
   behaviour; they don't suppress it.
5. **Audio is headerless PCM despite the `.wav` name** — s16le, mono, 44.1 kHz.
   A real WAV file with a RIFF header is not what the firmware wants.
6. **`/api/openapi.json` does not exist.** It's `/openapi.yaml` at the root.
7. **`/api/screen` wants an integer.** `?display=0` (front) / `1` (back), not
   `front`. Despite the `image/bmp` content type the body is **base64 text** of
   raw 72×16 **BGR** pixels — no BMP header. Swap the byte order or your colours
   come back reversed. This is how to check a layout without eyeballing the panel.

## Working style for this repo

- Prefer verifying against the live Bar over trusting the docs. Several
  published details were wrong or absent; every claim in `docs/busy-bar-api.md`
  marked *verified* was checked against the device.
- When you learn something new about the API, add it to `docs/busy-bar-api.md`
  and mark whether it's verified or inferred.
- Keep `docs/verification.md` honest — it's the record of what's actually been
  proven on hardware. Don't upgrade something to "verified" without running it.
