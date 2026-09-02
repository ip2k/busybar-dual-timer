# Where to pick up

## Immediate next step

**Hold the button.** The long-press A↔B switch is the only gesture never
exercised — `POST /api/input` sends a single press with no duration, so it
cannot be faked. Everything else in the cycle has now run against the device
(see `docs/verification.md`): startup, stream, tap, multi-tap reset, expiry,
audio, draw, clean shutdown.

While you are there, confirm what the firmware does with the same press
underneath the widget, and let it run for an hour or two to see whether the
stream stays up.

**Before running over Wi-Fi**, note that `192.168.1.163` — the host in
`config.json` — was not serving the API during verification; the Bar answered
over USB at `10.0.4.20`. Re-check the Bar's LAN address and update `config.json`.

**Audio no longer needs worrying about.** It was the flagged risk and it works:
upload and playback both returned OK, using the synthesised chime.

## Then, roughly in order of value

1. **Tune the gesture timings on real hardware.** `longPressMs: 700` and
   `multiTapWindowMs: 400` are reasoned defaults, not measured ones. Captured
   taps ran 68–141 ms, so there is a lot of headroom — the window could likely
   come down, cutting start/pause latency in `deferred` mode.
2. **Decide on `tapMode`.** `deferred` and `immediate` are both implemented and
   the trade is real (see `docs/architecture.md`). Pick one after using both.
3. ~~**Resolve `GET /api/screen`.**~~ **Done.** `?display=0` (integer) works;
   the reply is base64 of 72×16 BGR pixels despite the `image/bmp` header. The
   layout has been confirmed from a frame grab, and scripted visual checks of
   `render.ts` output are now possible — worth wiring into a test.
4. **Test `{"enable": false}` on the status WebSocket.** If input events still
   arrive without the once-a-second display frames, flip
   `behavior.streamFrames` to `false` by default.
5. **Deploy as a service** on the Ubuntu box (`192.168.1.25`, user `likwid`)
   using the bundled `busy-dual-timer.service`. Note that box was reported to be
   crashing every few hours to days as of Sept 2026 (it pings fine as of this run) — worth confirming it's
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
