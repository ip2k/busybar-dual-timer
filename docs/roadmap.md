# Where to pick up

## Immediate next step

Run it. `npm run dev` on a machine on the LAN with the Bar reachable, and walk
the checklist at the end of `docs/verification.md`. Nothing else in this list
matters until the assembled program has driven a full cycle.

The most likely thing to break first is **audio** — the PCM format is inferred
from busylib's ffmpeg arguments and the upload/play calls have never been made
against this device. If it fails, `expiry.sound.mode: "none"` disables it
cleanly and the flash still works.

## Then, roughly in order of value

1. **Tune the gesture timings on real hardware.** `longPressMs: 700` and
   `multiTapWindowMs: 400` are reasoned defaults, not measured ones. Captured
   taps ran 68–141 ms, so there is a lot of headroom — the window could likely
   come down, cutting start/pause latency in `deferred` mode.
2. **Decide on `tapMode`.** `deferred` and `immediate` are both implemented and
   the trade is real (see `docs/architecture.md`). Pick one after using both.
3. **Resolve `GET /api/screen`.** It returned 400 with `?display=front`; the TS
   library suggests a numeric `display`. Getting a frame grab working would
   allow scripted visual checks of the layout instead of eyeballing the panel.
4. **Test `{"enable": false}` on the status WebSocket.** If input events still
   arrive without the once-a-second display frames, flip
   `behavior.streamFrames` to `false` by default.
5. **Deploy as a service** on the Ubuntu box (`192.168.1.25`, user `likwid`)
   using the bundled `busy-dual-timer.service`. Note that box was reported to be
   crashing every few hours to days as of Sept 2026 — worth confirming it's
   stable before relying on it as a host.

## Ideas not yet explored

- **Drive `/api/busy/*` instead of rendering our own display.** The firmware has
  a built-in BUSY timer with profile slots; mapping A and B onto two profiles
  might feel more native and would survive the widget process dying. Unknown how
  much control the API gives.
- **Use `countdown` elements.** Would remove the per-second redraw entirely, at
  the cost of font control. Worth a look if network chattiness ever matters, or
  if the default countdown rendering turns out to look good.
- **Use the encoder wheel and mode switch.** `proto.ts` already decodes
  `EncoderEvent` and `SwitchEvent`, but neither was observed during testing. The
  wheel is an obvious way to dial timer lengths on-device without editing config
  — which was the third option offered during design and not taken.
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
