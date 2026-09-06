# Porting to the on-device JavaScript runtime

Firmware **1.2.3** (device API **27.5.0**, released 2026-09-03) added a
JavaScript runtime and an app format. `docs/roadmap.md` has always listed
"port to an on-device app when the JS SDK ships" as the largest open item, so
this is the first real chance to close it.

This document is the result of taking that chance. Short version:

> **Rendering ports today. Input does not, and input is the whole app.**
> The runtime has no WebSocket and the HTTP API can only *send* input events,
> never report them, so an on-device app cannot read the START button or the
> dial. Everything else — drawing, timing, the pure modules, packaging,
> installing — works.

The recommendation is therefore **not to port yet**, to keep this branch as the
prepared groundwork, and to revisit the moment an input binding appears. The
work is small once that lands; see [What a port would actually cost](#what-a-port-would-actually-cost).

## How to reproduce any of this

```bash
node tools/js-app.mjs build     # bundle src/ + js-app/src/ into one script
node tools/js-app.mjs install   # upload to the Bar
node tools/js-app.mjs logs      # read console output back over HTTP
node tools/js-app.mjs remove    # uninstall
```

Then launch **Dual Timer** from the device's APPS menu.

`logs` is the useful one: `console.log` in a JS app goes to the firmware log,
and 1.2.3 added `POST /api/log_dump`, which snapshots that log to a file you
can then `GET /api/storage/read`. **A JS app can be debugged entirely over the
network** — no serial cable, no USB. That was not possible before this release.

## What the runtime is

JerryScript 3.0 — specifically [Flipper's fork](https://github.com/flipperdevices/jerryscript),
pinned as a submodule at `lib/jerryscript` — built with `JERRY_MODULE_SYSTEM=1`,
`JERRY_BUILTIN_REFLECT=0`, and Date, JSON, Math, RegExp, TypedArray, DataView,
Proxy, BigInt and containers enabled. It is a modern ES engine, not ES5:
classes, promises and `async`/`await` all work, which is why the firmware's own
`fetch.js` sample uses `for await`.

The bindings the firmware adds are, in full:

| Binding | Source file |
| --- | --- |
| `console.log` / `.info` / `.error` | `js_console.c` |
| `fetch`, `Request`, `Headers`, `Response` | `js_fetch.c`, `js_request.c`, `js_headers.c` |
| response `.json()` `.text()` `.arrayBuffer()` `.bytes()` `.blob()` `.formData()` `.body` | `js_fetch_body_methods.c` |
| `ReadableStream` with `getReader()` / `read()` / `cancel()` | `js_readable_stream.c` |
| `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` | `js_interval.c` |
| `localStorage` (`getItem`, `setItem`, `removeItem`, `clear`, `key`) | `js_local_storage.c` |

**That is the entire custom surface.** There is no display binding, no input
binding, no audio binding and no filesystem binding.

### There is no privileged API — a JS app is an HTTP API client

This is the single most important structural fact, and it is a pleasant
surprise. The firmware's own example app draws by POSTing to
`http://127.0.0.1/api/display/draw`, exactly as this project does from a
laptop. The official docs say it outright: JavaScript applications are "a
locally-run form of HTTP API applications."

So a port does **not** throw away `api.ts` and rewrite against native calls. It
keeps the same client, points it at loopback, and drops the token — local
requests are unauthenticated. Much of this repo transfers directly.

## The blocker: input

An on-device app has no way to learn that a button was pressed.

- The runtime has **no WebSocket binding**, so `/api/status/ws` — the only
  source of input events, and the one this project's `proto.ts` decodes — is
  unreachable. `fetch` cannot perform a protocol upgrade.
- `POST /api/input` **sends** a key event. There is no corresponding read. The
  full 1.2.3 OpenAPI spec was searched: no endpoint, schema or field anywhere
  exposes button, encoder or key state.
- `GET /api/status` returns device, firmware, system and power information
  only.

For a display widget this does not matter. For a timer driven by START and the
dial, it is fatal: the app could count down but could never be started,
paused, switched or reset.

### The one indirect channel

`GET /api/busy/snapshot` returns the **native** BUSY timer's live state
(`type`, phase, timestamps) and is pollable over `fetch`. Since the physical
controls do drive that built-in timer, an app can observe the results of user
input on it.

That is an observation channel, not general input — it says what the firmware's
timer is doing, not what the user pressed. But it is the only feedback path a
JS app has from the physical controls today, and it makes a different design
thinkable: drive `/api/busy/profiles/{slot}` and let the firmware own both
input and display. `docs/roadmap.md` already lists that as an unexplored idea;
the JS runtime makes it more interesting, not less.

## Other findings

### Modules do not resolve, so the app must be one file

`js_runner.c` parses the entry script with `JERRY_PARSE_MODULE` and then calls
`jerry_module_link(parsed_script, NULL, NULL)` — **a NULL resolver**. Nothing
can load `./other.js` off the filesystem.

The consequence: despite `js_app.h` documenting a `scripts/` directory
containing `module1.js` and `module2.js`, **only `main.js` can execute**, and a
multi-module app must be bundled into it. Since this repo forbids runtime
dependencies, `tools/js-app.mjs` owns a ~30-line bundler that walks the import
graph, strips `import`/`export` and concatenates in dependency order. It
refuses to build on a top-level name collision, since flattening into one scope
would otherwise shadow silently.

Two side effects of `JERRY_PARSE_MODULE` worth knowing: the entry script is in
**strict mode**, and top-level `this` is `undefined`.

### There is no monotonic clock

`src/clock.ts` exists precisely because wall-clock time is not monotonic and a
countdown measured against it gains or loses time when NTP steps. JerryScript
exposes no `performance`, and nothing else monotonic — `Date.now()` is all
there is.

The bundle therefore shims `performance.now()` to `Date.now()`. **This is a
real behavioural regression, not a shim detail**, and it is worth stating
plainly: the device syncs its clock, so a step during a countdown is possible.
Any real port should either accept this or ask for a monotonic source.

### BACK stops fighting us

Trap #4 in `CLAUDE.md` is that BACK pops the firmware's navigation stack and
throws the widget off screen, which is why `behavior.reassertEveryMs` exists.

In a JS app that trap is gone: `js_app_launcher_scene_run.c` handles
`SceneManagerEventTypeBack` by consuming it. A running JS app is not backed out
of. Whether BACK can then be *used* as an app control is a separate question,
and the answer today is no — see the blocker above. The firmware source marks
the handler `// TODO: Special Back key treatment?`, so this may yet change.

### Apps live in the APPS menu, not on the CUSTOM lever

A large amount of care in this project goes into lever gating: the widget only
takes the panel on CUSTOM, so the device behaves completely normally otherwise.

An on-device app inverts that. Apps are enumerated from `/ext/user_assets` and
listed in the **APPS menu**; the user launches one explicitly and it runs until
it exits. That is a cleaner model than ours, and `behavior.activeSwitchPosition`,
the input gating and `reassertEveryMs` would all simply be deleted. But it is a
behavioural change for existing users, not a transparent port.

### Budgets

- **JS heap**: `heap_size_kib` in the manifest, 1–256 KiB, default 32. This
  app's probe asks for 64.
- **Thread stack**: 3 KiB, fixed in `js_app_launcher_scene_run.c`. Deep
  recursion is not an option.
- **Manifest**: parsed with a 512-byte file size cap.

### App package format

```
/ext/user_assets/
└── dev.ip2k.dualtimer/          <- must equal manifest "id"
    ├── appmeta/
    │   ├── manifest.json         required
    │   ├── settings.json         "to be decided" in the firmware docs
    │   ├── icon_front_8x8.png    8x8 colour
    │   └── icon_back_11x11.png   11x11 greyscale
    └── scripts/
        └── main.js               required, and in practice the only script
```

`id` is at most 32 characters matching `^[a-zA-Z0-9._-]+$` and **must** equal
the directory name. `version` must be `X.Y.Z`. `debug: true` hides the app
unless developer mode is on. Reverse-DNS ids are recommended, not required.

Installation is just file upload: `POST /api/storage/mkdir` and
`POST /api/storage/write`, both of which this project already had reason to
know. No packaging step, no signing, no store.

## What a port would actually cost

Assuming an input binding appears, from the modules as they stand today:

| Module | Fate |
| --- | --- |
| `timers.ts` | ports unchanged |
| `render.ts` | ports unchanged |
| `chime.ts` | ports unchanged (pure PCM synthesis) |
| `audio.ts` | ports, but WAV decoding on a 64 KiB heap needs thought |
| `api.ts` | keeps its shape; loopback, no token, no reconnect logic |
| `clock.ts` | degrades to wall time |
| `config.ts` | file I/O and CLI go; `localStorage` is the natural replacement |
| `proto.ts` | **deleted** — protobuf existed only to decode the WebSocket |
| `gestures.ts` | survives *if* input arrives; the device-timestamp defence goes |
| `index.ts` | mostly deleted: lever gating, reassertion, burst guards, reconnect |
| `audio-file.ts`, ffmpeg | gone — no subprocesses |

Most of the hardening in this repo compensates for being a remote client over a
possibly-bad network. On-device, `reassertEveryMs`, `maxEventsPerMessage`,
`STALE_MESSAGE_MS`, the device-clock gesture timing and the reconnecting socket
all stop being necessary. That is the prize.

### One thing to fix first, whatever happens

The pure modules port cleanly at runtime but **not at compile time**.
`timers.ts` and `render.ts` import *types* from `config.ts` and `api.ts`, which
are Node-bound (`node:fs`, `Buffer`, `process`). Type-only imports are erased,
so no Node code reaches the bundle — but `tsc` still has to load and check
those files, so the device build currently has to pull in `@types/node` to
typecheck a bundle that contains none of it.

Extracting `TimerConfig`, `DisplayElement` and `DrawPayload` into a Node-free
`src/types.ts` would fix that, is type-only, and would benefit the current app
too. It is not done on this branch to keep the diff about exploration.

## Verification status

Per `CONTRIBUTING.md`, claims here are marked for how they were established.

| Claim | Status |
| --- | --- |
| Device runs firmware 1.2.3 / API 27.5.0 | **verified** — `GET /api/status` |
| Apps are read from `/ext/user_assets` | **verified** — the stock `app.busy.js_example` is there, and `js_app_registry.c` agrees |
| Package format (`appmeta/`, `scripts/main.js`) | **verified** — matches the on-device example and the official docs |
| App installs over HTTP with no USB | **verified** — uploaded and listed back |
| `POST /api/log_dump` + `storage/read` returns console output | **verified** — dumped and read, including `[D]` level |
| No input endpoint exists in the HTTP API | **verified** — full 1.2.3 OpenAPI searched |
| No WebSocket binding in the runtime | **inferred** — read from the complete `js_runner` binding list |
| No `performance`, no monotonic clock | **inferred** — same source; probed at runtime by the app |
| Modules cannot resolve (NULL linker) | **inferred** — `jerry_module_link(script, NULL, NULL)` |
| BACK is consumed by the launcher | **inferred** — `js_app_launcher_scene_run.c` |
| The bundle parses and runs on-device | **UNVERIFIED — needs a launch from the APPS menu** |

The last row is the one that matters. `js-app/src/main.ts` probes the runtime at
startup and logs what it finds, so launching it once turns most of the
*inferred* rows above into verified ones.
