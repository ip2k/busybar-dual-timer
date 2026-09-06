# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a section here, and the release workflow reads it: the
GitHub release notes for `vX.Y.Z` are this file's `[X.Y.Z]` section. A release
will not be cut without one.

## [Unreleased]

## [1.1.0] - 2026-09-06

First release since the device gained firmware 1.2.3 (device API `27.5.0`, up
from `25.0.0`). Nothing here changes how the timer is operated.

### Added

- **Draw order is now explicit.** Every element carries `z_index`, added in
  device API 27.5.0. The firmware falls back to array order when it is absent,
  which worked, but made the layering an accident of how `elementsFor` built its
  list — the flash panel had to stay first or it would cover the time. Covered
  by a test that shuffles the array and asserts the top element is unchanged.
- **`docs/busy-bar-api.md` covers API 27.5.0**, including `display_until`,
  `element_ids` on `DELETE /api/display/draw`, `xpmbitmap` elements,
  `POST /api/log_dump`, and `POST /api/storage/write?append=1`. Claims are marked
  verified or inferred as usual.
- **A changelog**, this file, wired into the release workflow.

### Changed

- **The tick loop is aligned to the wall clock.** It used a plain
  `setInterval`, which fires relative to whenever the process started, so the
  tick that draws a new second sat at an arbitrary offset inside it — and
  drifted over a long run, leaving the display up to 200 ms out of step with
  every other clock in the room. Each delay is now computed from the clock, so
  ticks land on the second and a slow tick is absorbed rather than accumulated.
  The maths is `msUntilNextTick` in `src/clock.ts`, and it is tested.
- **The demo is rendered on the device's own 3D model.** Every panel frame in
  `docs/demo.gif` is a real photograph: built by this project's renderer, drawn
  to a Bar, and read back with `GET /api/screen?display=0`, then projected onto
  BUSY's published FBX. The pipeline is `tools/capture-frames.mjs`,
  `tools/render-demo.py`, `tools/make-backdrop.py` and `tools/compose-demo.py`,
  documented in [CONTRIBUTING.md](CONTRIBUTING.md).

### Notes

- `docs/demo.gif` and the generated backdrops are **GPL-3.0**, not MIT: they
  include the Flipper dolphin, whose source repository carries no asset licence
  and so falls under its own `LICENSE`. See
  [tools/vendor/README.md](tools/vendor/README.md). The project's code and
  documentation are unaffected.
- An attempt to port this app onto the Bar's new on-device JavaScript runtime is
  **not** included here. It got as far as running the timer state machine
  unmodified on-device with accurate timing, audio and a firmware-rendered
  countdown, then stopped: a JS app cannot read the buttons. The work, the
  tooling and the findings live on the
  [`js-runtime-port`](https://github.com/ip2k/busybar-dual-timer/tree/js-runtime-port)
  branch — see
  [docs/js-port.md](https://github.com/ip2k/busybar-dual-timer/blob/js-runtime-port/docs/js-port.md)
  and the summary sent upstream in
  [docs/firmware-feedback.md](https://github.com/ip2k/busybar-dual-timer/blob/js-runtime-port/docs/firmware-feedback.md).

## [1.0.4] - 2026-09-02

### Security

- Refuse HTTP redirects (`redirect: 'error'`). The Bar never redirects, and
  following one would have sent the API token and the request body to whatever
  host the response named — on plain HTTP, anyone on the path. ([`6db4d20`])
- Sanitise device-supplied strings before logging, so error bodies cannot write
  escape sequences into a terminal or journal. ([`6db4d20`])
- Bound sound decoding: at most 8 MB on disk and 30 seconds of audio, with the
  sample rate checked. A 20 KB file claiming a 1 Hz rate previously expanded
  into 1.7 GB of PCM. ([`6db4d20`])
- Type-check every config value rather than range-checking it, so a string where
  a number belongs is an error instead of a coercion. ([`6db4d20`])
- Harden the release workflow against tag injection, and pin actions to commit
  SHAs. Git accepts tag names containing backticks and `$( )`, which the
  workflow previously pasted into a shell. ([`6db4d20`])
- Exclude source maps from the published package. ([`6db4d20`])

## [1.0.3] - 2026-09-02

### Changed

- Publish to npm with **trusted publishing (OIDC)** instead of a stored token,
  so no npm credential exists in the repository at all. ([`447f1a9`])
- Publish to npm *before* creating the GitHub release, so a failed publish
  cannot leave a release advertising a version npm does not have. ([`571b8c3`])
- Rename the repository and package to `busybar-dual-timer`, following the npm
  convention for BUSY Bar apps. ([`24b81b8`], [`a3c7d16`])

### Security

- Fix a path traversal in asset filenames: `expiry.sound.file` is joined onto a
  directory and uploaded, so `../../../../etc/passwd` would have sent that
  file's contents to the device. Asset names must now be bare filenames.
  ([`f2af94f`])
- Give CI a read-only token. ([`f2af94f`])

> `1.0.2` was tagged but never published: the npm publish failed with `EOTP`
> after provenance had been signed, because the token required a one-time
> password CI cannot answer. The tag was deleted and the fix shipped in `1.0.3`.

## [1.0.1] - 2026-09-02

### Added

- Installable with `npx busybar-dual-timer`. ([`7aad77d`])

### Changed

- Move building, tagging and publishing entirely into CI. ([`7aad77d`])

> Published from a laptop, and therefore the one version **without provenance**.

## [1.0.0] - 2026-09-02

First public release. Two configurable countdowns on a BUSY Bar, driven
off-device over the local HTTP API.

### Added

- Two independent timers, A and B, with banking: switching preserves the
  outgoing timer's remaining time and never leaves a countdown running.
- Controls on START and the scroll wheel — press to start/pause, click the dial
  to switch, double-click to reset, turn to adjust. BACK is deliberately
  unbound; it pops the firmware's navigation stack and throws the widget off
  screen. ([`ac78f6f`])
- Lever gating, so the widget takes the panel only on CUSTOM and the device
  behaves completely normally in every other position.
- An inverting expiry alarm, and a DONE panel that holds until acknowledged.
  ([`2f7b4ff`], [`8ba368b`])
- Configurable colours, lengths, sounds and LED behaviour via `config.json`,
  with `--init` to write a starter file.
- Custom expiry sounds, converted for the device automatically, with ffmpeg used
  only when a format needs decoding.
- Display brightness control, including an ambient-light `auto` mode.
  ([`2233b72`])
- The device's own fonts and brand colours, so the widget reads as native.
  ([`0e3df22`])
- CI on Node 22 and 24, and a release workflow that builds, tags and publishes.
  ([`bbbeef7`], [`b467ffe`])

[Unreleased]: https://github.com/ip2k/busybar-dual-timer/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ip2k/busybar-dual-timer/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/ip2k/busybar-dual-timer/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/ip2k/busybar-dual-timer/compare/v1.0.1...v1.0.3
[1.0.1]: https://github.com/ip2k/busybar-dual-timer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ip2k/busybar-dual-timer/releases/tag/v1.0.0
[`6db4d20`]: https://github.com/ip2k/busybar-dual-timer/commit/6db4d20
[`447f1a9`]: https://github.com/ip2k/busybar-dual-timer/commit/447f1a9
[`571b8c3`]: https://github.com/ip2k/busybar-dual-timer/commit/571b8c3
[`24b81b8`]: https://github.com/ip2k/busybar-dual-timer/commit/24b81b8
[`a3c7d16`]: https://github.com/ip2k/busybar-dual-timer/commit/a3c7d16
[`f2af94f`]: https://github.com/ip2k/busybar-dual-timer/commit/f2af94f
[`7aad77d`]: https://github.com/ip2k/busybar-dual-timer/commit/7aad77d
[`ac78f6f`]: https://github.com/ip2k/busybar-dual-timer/commit/ac78f6f
[`2f7b4ff`]: https://github.com/ip2k/busybar-dual-timer/commit/2f7b4ff
[`8ba368b`]: https://github.com/ip2k/busybar-dual-timer/commit/8ba368b
[`2233b72`]: https://github.com/ip2k/busybar-dual-timer/commit/2233b72
[`0e3df22`]: https://github.com/ip2k/busybar-dual-timer/commit/0e3df22
[`bbbeef7`]: https://github.com/ip2k/busybar-dual-timer/commit/bbbeef7
[`b467ffe`]: https://github.com/ip2k/busybar-dual-timer/commit/b467ffe
