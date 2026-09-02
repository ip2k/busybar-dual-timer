# Where to pick up

## Immediate next step

**Let it soak.** Every gesture and every stage of the cycle has now run against
the device, by hand, over both USB and Wi-Fi (see `docs/verification.md`). What
is left is time: clock drift over hours, reconnect after a real network drop,
and what happens when the Bar sleeps. Leave it running for a working session and
see whether the stream stays up.

Two smaller things still uncharacterised, both needing a person at the device:

- Whether any switch position changes what START does natively. No interference
  showed up in the by-hand run, but the position was not recorded — so this is
  narrowing, not closed.
- Dismissing an expiry with a physical tap (expiry has only ever timed out on
  its own).

**Tuning is now the interesting work**, not correctness — see item 1 below.

## Then, roughly in order of value

1. **Tune the gesture timings.** `longPressMs: 700` and `multiTapWindowMs: 400`
   both work in the hand now, but they are still reasoned defaults rather than
   measured ones. Captured taps ran 68–141 ms, so there is a lot of headroom —
   the window could likely come down, cutting start/pause latency in `deferred`
   mode. This is the highest-value remaining change.
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
