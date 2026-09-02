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

1. **Tune `multiTapWindowMs`.** `longPressMs: 700` is **settled** — confirmed by
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
