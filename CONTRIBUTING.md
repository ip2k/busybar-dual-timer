# Contributing

Pull requests are welcome. This is a small project with a few opinions, and
knowing them up front should save you a round trip.

## Getting set up

```bash
npm install          # dev-only: typescript + @types/node
npm test             # offline; no BUSY Bar required
npm run typecheck
```

**You do not need a device to contribute.** The smoke test covers the protobuf
decoder against real captured device frames, the gesture mapping, timer banking,
render bounds and audio conversion. If your change is to `timers.ts`,
`render.ts`, `audio.ts`, `proto.ts` or `gestures.ts`, the test suite is a
genuine check and CI will run it for you.

If you *do* have a Bar, see the README for setup. `npm run dev` runs from source.

## The rules that aren't obvious

**Zero runtime dependencies.** This is deliberate, not an accident. The whole
protobuf need is ~150 lines, and owning it is what allows pinning firmware
quirks with tests against real captured bytes. A PR adding a runtime dependency
needs to argue for itself. Dev dependencies are a much easier sell.

**No TypeScript parameter properties, and no `enum`.** Node's native type
stripping — which `npm run dev` relies on — rejects both. Write explicit fields
and assign in the constructor; use `as const` unions instead of enums. This is
easy to violate by accident and the failure is at runtime, not compile time.

**Relative imports carry the `.ts` extension.** `tsc` rewrites them on build via
`rewriteRelativeImportExtensions`.

**Keep the pure modules pure.** `timers.ts`, `render.ts` and `audio.ts` have no
I/O, no network and no side effects. That is precisely what makes the offline
test suite meaningful. I/O belongs in `api.ts`, orchestration in `index.ts`.

**Config keys are optional and deep-merged.** Add a new key to *both* the
`Config` interface and the `DEFAULTS` object in `config.ts`, and validate it.

## Claims about the hardware

This project keeps two documents that are only worth having if they stay honest:

- **`docs/busy-bar-api.md`** — what the device actually does. Mark each claim
  **verified** or **inferred**, and say which.
- **`docs/verification.md`** — the log of what has been proven on real hardware,
  and what has not.

**Do not mark something verified unless you ran it.** Several things here were
wrong for a while precisely because a plausible-looking result was taken at face
value. Two worth knowing about:

- `POST /api/audio/play` returns `200 {"result":"OK"}` for files that **do not
  exist**. Audio can only be verified by a person listening to the device.
- The draw API is similarly agreeable. Confirm an upload landed by listing
  `/ext/user_assets/<app>/`, and confirm the display by grabbing a frame from
  `/api/screen?display=0`.

If you learn something new about the device, add it to `docs/busy-bar-api.md`
with its status. Negative results are welcome — "I tried X and it did nothing"
saves the next person real time.

## Pull requests

- Keep the change focused. Unrelated fixes are easier to review separately.
- Run `npm test` and `npm run typecheck`. CI runs both on Node 22 and 24.
- Explain **why**, not just what. The commit log here tries to record reasoning
  and the occasional wrong turn; that history has been genuinely useful.
- If it changes behaviour on the device, say what you observed — ideally a log
  excerpt or a frame grab.
- New behaviour that can be tested offline should come with a test. If you can,
  check the test fails without your fix; a few tests here were confirmed
  meaningful that way.

## Ideas

`docs/roadmap.md` lists what is unfinished, including things deliberately not
done and why. The largest open item is porting to an on-device app when BUSY
ship their JS SDK — the pure modules are shaped to survive that move.

## Licence

By contributing you agree your work is licensed under the [MIT
Licence](LICENSE), the same as the rest of the project.
