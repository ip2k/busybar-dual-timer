# Where to pick up

## Immediate next step

**Try the current control scheme by hand.** It changed twice in quick succession
after hardware use, and the latest version has not been used in anger:

| Control | Action |
| --- | --- |
| START | start / pause |
| dial click | switch A ↔ B |
| dial double-click | reset |
| dial turn | ±1 minute |
| dial click + turn | ±5 seconds |

Worth paying attention to whether the 300 ms `doubleTapMs` makes a single click
feel sluggish — that window is the price of keeping reset off BACK.

## Then, roughly in order of value

1. **~~Tune `multiTapWindowMs`.~~ Gone.** The control remap deleted the
   multi-tap window along with `tapMode` and `longPressMs`; nothing is
   overloaded any more, so there is nothing to wait out. The remaining timing
   knob is `gestures.doubleTapMs`.

   Old notes, kept because the measurements are still useful: `longPressMs: 700` is **settled** — confirmed by
   feel on hardware, it reads as deliberate without dragging. Leave it.

   `multiTapWindowMs: 400` is the one still worth moving. In `deferred` mode it
   is not just a recogniser detail: a single tap cannot be known to be single
   until the window closes, so **400 ms is exactly the start/pause lag**. The
   It is now **measured**: a real rapid triple-click ran 147–182 ms press-to-press
   (81–92 ms release-to-next-press), so 400 ms carries roughly 2x margin. Around
   **250 ms** would keep comfortable headroom while cutting 150 ms off every
   start/pause. Worth trying by feel before committing to a number — and note the
   measurement is from the dial click, so confirm it holds for the START button.

   The alternative is `tapMode: "immediate"`, which removes the lag entirely at
   the cost of flickering through intermediate states during a triple tap. Same
   end state either way; see `docs/architecture.md`.
2. **Decide on `tapMode`.** `deferred` and `immediate` are both implemented and
   the trade is real (see `docs/architecture.md`). Pick one after using both.
3. ~~**Resolve `GET /api/screen`.**~~ **Done.** `?display=0` (integer) works;
   the reply is base64 of 72×16 BGR pixels despite the `image/bmp` header. The
   layout has been confirmed from a frame grab, and scripted visual checks of
   `render.ts` output are now possible — worth wiring into a test.
4. **Test `{"enable": false}` on the status WebSocket.** If input events still
   arrive without the once-a-second display frames, flip
   `behavior.streamFrames` to `false` by default.
5. **Deploy as a service** on the Ubuntu box (`<host>`, a dedicated user)
   using the bundled `busybar-dual-timer.service`. Note that box was reported to be
   crashing every few hours to days as of Sept 2026 (it pings fine as of this run) — worth confirming it's
   stable before relying on it as a host.

## Port to an on-device app when the JS SDK ships

The intent is to make this a real BUSY Bar app rather than a remote client, once
BUSY release their JS SDK. Everything off-device is a consequence of what the
platform supports today.

The module split already anticipates it: `timers.ts`, `render.ts` and `audio.ts`
are pure and port unchanged; `api.ts` and `index.ts` exist because there is a
network in the way. A good chunk of the hardening in this repo — device-clock
gesture timing, `reassertEveryMs`, `maxEventsPerMessage` — is compensating for
being a remote client and would simply be deleted.

Watch <https://docs.busy.app/bar/dev> for the SDK.

## Named timer profiles (on-device)

Once the JS app Setup screen exists, the natural feature is **named profiles** —
several A/B pairs saved and recalled by name, instead of dialling lengths in
every time. "Pomodoro 25/5", "Long session 50/10", "Tea 3/0".

Deliberately not started. The firmware's Setup scene currently renders "Not
implemented", and `appmeta/settings.json` is "To be decided" in the official
docs, so the storage format and the UI affordances are both unknown — anything
built now would be built against a guess. `localStorage` exists in the runtime
and is the obvious place to keep them when the time comes.

See `docs/js-port.md`.

## Ideas not yet explored

- **Drive `/api/busy/*` instead of rendering our own display.** The firmware has
  a built-in BUSY timer with profile slots; mapping A and B onto two profiles
  might feel more native and would survive the widget process dying. Unknown how
  much control the API gives.
- **Use `countdown` elements.** Would remove the per-second redraw entirely, at
  the cost of font control. Worth a look if network chattiness ever matters, or
  if the default countdown rendering turns out to look good.
- **Dial speed ramping — tried, then removed.** The step used to multiply when
  the dial spun fast. On hardware it felt unpredictable and not especially
  responsive, and for the timers people actually set, one detent per minute is
  enough. Removed rather than left as dead config. If it comes back, the
  measurements in `docs/busy-bar-api.md` are the starting point — and note the
  first attempt failed because the thresholds were calibrated against a spin
  done *for a capture* (~600 ms/detent) rather than a spin done to set a timer
  (56–83 ms/detent).

- **Use the encoder wheel and mode switch.** No longer speculative: both are
  now confirmed on the wire, and `proto.ts` decodes them correctly as-is (see
  `docs/busy-bar-api.md`). Dialing timer lengths on-device is a small change —
  `index.ts` already receives `{kind: 'encoder', delta}` and simply ignores it.

  The dial gives three bindings, not one: rotate, click (`ok`), and click+spin,
  since rotation is delivered while the dial is held. An obvious shape is
  rotate = adjust the current timer while paused, click+spin = coarse steps.
  Needs rate-limiting: a fast spin emits detents 15 ms apart.
- **Back display.** 160×80 greyscale is completely unused. Could show both
  timers at once, or a session history.
- **More than two timers.** `DualTimer` is hardcoded to two slots because the
  requirement was two. Generalising to N with long-press cycling is
  straightforward if wanted.

## Known unknowns worth closing

Listed with more detail in the "Open questions" section of
`docs/busy-bar-api.md`: stock asset names, the `/api/screen` parameter shape,
`{"enable": false}` semantics, and confirmation of the encoder/switch field
mappings.
