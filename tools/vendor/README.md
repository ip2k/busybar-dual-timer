# Vendored third-party artwork

## `dolphin_71x25.png`

The Flipper dolphin, used in the demo backdrop.

| | |
| --- | --- |
| Source | [`flipperzero-firmware`](https://github.com/flipperdevices/flipperzero-firmware), `applications/examples/example_images/images/dolphin_71x25.png` |
| Copyright | Flipper Devices Inc. |
| Licence | **GPL-3.0**, per the repository's `LICENSE` |

**This file is not MIT-licensed, unlike the rest of this repository.**

`flipperzero-firmware` carries no `REUSE.toml` and no asset-specific licence
note, so its artwork falls under the repository's own `LICENSE`, which is
GPL-3.0. That is a copyleft licence, so anything built from this image inherits
it — which here means **`docs/demo.gif` and `docs/demo-backdrop-*.png` are
GPL-3.0**, not MIT. The project's own code and documentation are unaffected.

Worth noting for context: BUSY Bar and Flipper Zero come from the same company
(Flipper FZCO), and BUSY's own firmware artwork *is* explicitly licensed —
`assets/animations/**` and `assets/images/**` are CC-BY-SA-4.0 in its
`REUSE.toml`. The dolphin simply predates that and lives in the other
repository. If Flipper state a permissive or CC licence for it, this note and
the licence on the generated images can be relaxed accordingly.
