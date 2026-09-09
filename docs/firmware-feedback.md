# Notes for the BUSY Bar firmware team

Feedback from porting a real app to the JavaScript runtime introduced in
firmware **1.2.3** (device API `27.5.0`).

Context: [busybar-dual-timer](https://github.com/ip2k/busybar-dual-timer) is two
configurable countdowns driven off-device over the local HTTP API. When 1.2.3
shipped a JS runtime we tried to move it on-device. The attempt is on the
[`js-runtime-port`](https://github.com/ip2k/busybar-dual-timer/tree/js-runtime-port)
branch.

**Where to read more:**

| | |
| --- | --- |
| [docs/js-port.md](js-port.md) | The full port write-up — every finding, how each was established, and a module-by-module cost of the port. Everything below is drawn from it. |
| [js-app/src/main.ts](../js-app/src/main.ts) | The probe app itself. Imports the real timer state machine rather than reimplementing it, and reports what the runtime provides at startup. |
| [tools/js-app.mjs](../tools/js-app.mjs) | Build, install, read logs, read crash breadcrumbs, enable JS apps. Includes the bundler we needed because sibling modules do not resolve (#5). |
| [test/js-app-harness.mjs](../test/js-app-harness.mjs) | Runs the built bundle under Node against stubs. Asserts, among other things, that no response body is left unread — see #4. |
| [docs/busy-bar-api.md](busy-bar-api.md) | Our running notes on the HTTP API, each claim marked verified or inferred, now including what 27.5.0 added and the `Content-Length` measurements in #0. |

Every measurement here can be reproduced with `node tools/js-app.mjs build`,
`install`, then `logs`.

**We could not complete the port, for one reason** — see #1. Everything else
below is offered in the spirit of "this was great to work with, here is what
tripped us up." The runtime is genuinely pleasant: `fetch`, promises,
`async`/`await`, `localStorage` and `setInterval` all behaved, and the decision
to make JS apps ordinary HTTP API clients against `127.0.0.1` meant most of our
existing code moved across unchanged.

Every claim here was measured on a device running 1.2.3, not inferred from
source. Where we did read source, we say so.

One item below — the `Content-Length` note — is not about the JS runtime at
all. It came up afterwards, in the off-device app, and it is small enough to
fix in a line, so we have put it first rather than burying it.

---

## 0. `Content-Length` is padded, which trips up Node's `fetch`

Not a JS-runtime issue, and a small one — but it is the only thing here that
stops an integration dead, and the fix looks like a one-character change.

Responses appear to have their `Content-Length` value written into a
fixed-width field, so the header goes out padded with trailing spaces. Read off
the wire with a raw socket, `GET /api/version` is:

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 24[9 spaces]

{"api_semver":"27.5.0"}\n         <- exactly 24 bytes, so the count is right
```

The count is correct and the padding is legal — RFC 7230 §3.2 lets a field
value be followed by optional whitespace, which the recipient discards. Almost
everything does exactly that:

| Client | Result |
| --- | --- |
| curl | ok |
| Python `urllib` | ok |
| Node `node:http` | ok |
| Chromium `fetch` | ok |
| Deno `fetch` (hyper) | ok |
| **Node `fetch` (undici)** | **fails every request** |

undici reports the header as `24`, then decides the body it read was the wrong
length and aborts it mid-read:

```
TypeError: terminated
  cause: ResponseContentLengthMismatchError (UND_ERR_RES_CONTENT_LENGTH_MISMATCH)
```

We think that is undici being stricter than the spec requires, so it is
arguably their bug rather than yours. We mention it because of where it lands:
`fetch` is Node's built-in HTTP client, so it is what most people will reach
for first, and the failure is total — our off-device app died on its opening
`GET /api/version` with the single word `terminated`, having made no successful
call at all. It took a raw socket to see why, because leading whitespace *is*
tolerated and trailing whitespace is not, so the header looks perfectly normal
in every debugger and in `curl -v`.

Reproduced 10/10 against a 1.2.3 device, and again against a local server
serving those exact bytes. We have worked around it by moving to `node:http`.

**Request:** drop the field width when emitting the header, if that is all it
is. We are happy to re-test a build against the same app and report back.


## 1. There is no way for a JS app to read input

**This is the only thing that blocked us.** Everything else has a workaround.

- The runtime exposes no input binding.
- There is no WebSocket, so `/api/status/ws` — the only source of button and
  encoder events — is unreachable, and `fetch` cannot upgrade a connection.
- `POST /api/input` *sends* a key event; nothing reads one. We searched the
  whole 27.5.0 OpenAPI document: no endpoint, schema or field exposes button,
  encoder or switch state.

So an on-device app can render but cannot be operated. For a timer driven by
START and the dial, that is fatal — it could count down but never be started,
paused, switched or reset.

**What would help, in rough order of preference:**

1. An input binding in the runtime — a callback or event source delivering the
   same events the status WebSocket carries.
2. Failing that, a readable HTTP endpoint (long-poll or last-event) so an app
   could poll its own device.
3. Failing that, a WebSocket client binding, which would let apps reuse the
   existing protobuf stream.

Any one of these turns JS apps from widgets into applications.

## 2. `CountdownElement` has no `font`

The highest-value small change on this list.

A per-frame redraw is not viable on-device (see #3), so firmware-side rendering
via a `countdown` element is the only way to update a display every second. But
`countdown` accepts only `timestamp`, `direction`, `show_hours` and `color`.

Measured from `GET /api/screen?display=0`: the countdown renders **5 rows tall
in the 16-pixel front panel**. The `extra_large` face (`busy_bold_10`) that our
app uses for the same digits is 10 rows. Half the height, under a third of the
panel. It is legible, but beside the built-in clock app it reads as an unstyled
fallback, and a user of ours described it unprompted as "not great... just quite
small."

**Request:** a `font` field on `CountdownElement`, taking the same enum
`TextElement` already accepts. `countdown` already supports `color`, so this
looks like a small addition — and it is the difference between an app that
matches the device's typography and one that does not.

## 3. `fetch` starts a thread per request, and latency degrades with load

From `applications/services/js_runner/js_fetch.c`:

```c
#define FETCH_THREAD_STACK_SIZE (10 * 1024)
FuriThread* thread = furi_thread_alloc_ex("Fetch", FETCH_THREAD_STACK_SIZE, ...);
furi_thread_start(thread);
```

One dedicated 10 KiB-stack thread per in-flight request, with no pool, no queue
and no cap. Measured effect, pairing each send with its logged completion:

| Requests in a run | Loopback draw latency |
| --- | --- |
| 7 | **~1.0 s** |
| 69 | **~3.5 s** |

Identical code, identical endpoint — only concurrency differed. Requests compete
for the same scheduler, so spending the budget also makes every remaining
request slower. Under heavier load the device became unstable.

**Requests:** a bounded worker pool or a documented concurrency cap, so that
exceeding it queues or rejects rather than degrading. Even a documented ceiling
("no more than N concurrent fetches") would let apps be written safely.

## 4. An unread response body leaks the request permanently

The sharpest footgun we hit, and the direct cause of repeated instability.

In `js_fetch.c`, once the promise resolves the response becomes
`ChildStatusRunning`; while it stays unread every incoming chunk is queued
rather than discarded; and the `JsFetch` is freed only when promise, response
and sink are all done. So this leaks the struct, its thread and all buffered
body data, every time it runs:

```js
fetch(request).then((response) => { /* body never read */ });
```

That is ordinary, idiomatic code — on the web it is fine, and our off-device
client is written exactly that way because there it *is* fine. On device, at one
draw per frame, it is a countdown to a crash.

**Requests:** discard the body when a response is garbage-collected or its
promise settles unread; or, at minimum, document it prominently. A warning
logged on the first unread body would have saved us a day.

## 5. Multi-file apps are documented but cannot work

`lib/js_app/js_app.h` documents a `scripts/` directory containing `main.js`,
`module1.js`, `module2.js`, and the official *JavaScript Applications* page
repeats that "any number of additional `.js` files may be present".

They cannot be loaded. `js_runner.c` parses with `JERRY_PARSE_MODULE` and then
calls `jerry_module_link(parsed_script, NULL, NULL)` — a NULL resolver — so
nothing can resolve a sibling file. Confirmed on device: dynamic `import()`
raises `SyntaxError`.

We worked around it by writing a small bundler. That is fine, but the docs
currently promise something the firmware does not do.

**Request:** either wire a filesystem module resolver, or correct the
documentation. The first would remove the need for a build step entirely, which
would be a real gift to small apps.

## 6. No monotonic clock

There is no `performance`, and nothing else monotonic. `Date.now()` is all there
is.

Our app deliberately measures every duration against a monotonic clock, because
wall time is not monotonic — the device syncs its clock, and a step during a
countdown makes a timer gain or lose time, or expire instantly. On-device we had
to fall back to `Date.now()` and accept that risk.

**Request:** `performance.now()`, or any monotonic millisecond source.

## 7. Ending a script with a request in flight is unsafe

`js_runner.c` tears the app down when the script runs out of work and calls
`abort_fetches()` on anything outstanding. Our shutdown path cleared its
interval, issued a final `DELETE`, and let the script end — and the device
restarted. A breadcrumb written to `localStorage` seven seconds earlier is how
we found it; the log buffer is cleared by the restart, so the log is empty for
exactly the run that matters.

The fix on our side was to clear the interval *inside* the final response
handler. But an app should not be able to crash the device by finishing.

**Request:** let teardown drain or safely abandon in-flight requests.

Related, in the same file:

```c
furi_check(request.body.data); // okay to crash - body handling TODO
```

`furi_check` panics the device. A malformed request body from a *script* should
raise a JS exception, not take the device down.

## 8. Smaller things

- **`js_apps_enabled` is undocumented.** JS apps do not appear in the APPS menu
  until `/ext/apps_data/apps_menu/js_apps_enabled` exists; before that the menu
  shows a "Coming soon" placeholder. Nothing we could find documents this, and
  it looks exactly like a broken install. Worth a line in the JS Applications
  page.
- **`Headers` and `Response` are not constructible.** Both are implemented, and
  responses do carry `.json()`, `.text()` and `.status`, but neither is exposed
  as a global constructor.
- **No `TextEncoder`, `TextDecoder`, `atob` or `btoa`.** This matters more than
  it looks: uploading a sound means handing raw PCM to the API, and
  `GET /api/screen` returns base64. Either forces a hand-rolled codec on a heap
  of at most 256 KiB.
- **No `AbortController` or `URL`.**
- **`console.log(a, b, c)` emits one log line per argument**, so a single
  message arrives split across three lines with the tag repeated. Joining
  arguments with a space, as browsers and Node do, would make logs far easier
  to read.
- **Settings are a stub.** `js_app_launcher_scene_setup.c` renders "Not
  implemented" on both displays, and `appmeta/settings.json` is "To be decided".
  We would use it immediately — timer lengths, and named profiles recalled
  instead of re-entered. Being able to declare a few typed settings and have the
  firmware render the UI would be excellent.

## What worked well

Worth saying, since the list above is all problems:

- **JS apps being ordinary HTTP API clients against `127.0.0.1` is the right
  call.** Our `api.ts` kept its shape instead of being rewritten, and our pure
  modules — the timer state machine and the renderer — ran on-device unmodified
  and kept accurate time. That is a genuinely low-friction porting story.
- **`POST /api/log_dump` plus `GET /api/storage/read` makes a JS app debuggable
  entirely over the network.** No serial cable. This was how we did everything.
- **Installing an app is just file upload** to `/ext/user_assets/<id>/`. No
  packaging, no signing, no store. Getting a build onto the device is one HTTP
  request per file.
- **The manifest format is small and obvious**, and requiring the directory name
  to match the id catches a whole class of mistake early.
- **`z_index`, `display_until` and `element_ids` on delete** (new in 27.5.0) are
  all things we wanted before they existed.
