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

## CI and releases

**Every push and pull request** runs `.github/workflows/ci.yml`: `npm ci`,
typecheck, the offline test suite, a build, and a check that `dist/index.js`
actually exists. It runs on **Node 22 and 24** — 22 is the floor in `engines`,
and 24 matters because type stripping is experimental on 22 and built in from
23, so the two take different paths.

Nothing in CI needs a BUSY Bar.

### Cutting a release

**Releases happen entirely in CI — nothing is built, tagged or published from a
laptop.** Go to **Actions → Release → Run workflow**, choose `patch`, `minor`,
`major` or an exact version, and run it. That single job:

1. Runs `npm ci`, typecheck and the test suite **before** versioning, so a tag
   is never created for a red tree.
2. Runs `npm version`, which commits the bump and creates the tag, then pushes
   both.
3. Builds, and checks `dist/index.js` actually exists.
4. Assembles the release bundle: `dist/`, config example, README, LICENSE, the
   systemd unit, `docs/`, an `assets/` directory for custom sounds, and
   `QUICKSTART.txt`.
5. **Smoke-tests the bundle it just built** — unpacks it, runs `--help` and
   `--version`, then starts it and fails the release if it dies on a missing
   module, a syntax error or a bad config rather than on the network. Something
   that cannot start should never reach a release page.
6. Publishes the GitHub release with the tarball and a `.sha256`.
7. Publishes to npm, with provenance.

Pushing a `v*` tag by hand runs the same job from step 3, for anyone who
prefers that.

#### npm publishing

Step 7 is skipped, with a warning rather than a failure, unless an `NPM_TOKEN`
repository secret exists — so a fork without npm access still gets working
GitHub releases. To enable it, create a **granular automation token** on npm
with publish rights to this package and add it as `NPM_TOKEN` under
Settings → Secrets and variables → Actions.

This project uses **npm trusted publishing (OIDC)**. The registry trusts this
repository and the `Release` workflow directly, so there is no token stored
anywhere — nothing to rotate, nothing to leak, and no 2FA prompt for CI to fail
on. Provenance comes with it, so npm shows a verifiable link to the exact commit
and run that built each version.

Two consequences worth knowing:

- The publish step is gated on the repository name, not on a secret. A fork
  runs the whole pipeline and simply skips publishing.
- Trusted publishing needs npm 11.5.1 or newer, which Node 22 does not ship, so
  the workflow upgrades npm before publishing.

If you ever fall back to a token, it has to publish without a one-time
password: CI cannot answer an OTP prompt, and it fails with `EOTP` *after*
signing provenance, which makes it look like it nearly worked. A granular token
needs the account's 2FA set to *authorization only*; a classic automation token
bypasses 2FA but cannot be scoped to one package.

npm publish runs *before* the GitHub release is created, so a failure stops the
run rather than leaving a release advertising a version npm does not have. The
tag is pushed earlier, so a failed publish can leave a tag behind — delete it
with `gh release delete <tag> --cleanup-tag`, or move on to the next patch.

Publishing to npm is close to permanent: unpublishing is restricted after 72
hours and the name stays burned. GitHub releases can be deleted freely.

The point of the bundle is that someone who only wants the timer needs Node 22+
and nothing else — no clone, no `npm install`, no toolchain.

Both workflows use only `actions/checkout`, `actions/setup-node` and the `gh`
CLI preinstalled on runners, so there are no third-party actions in the supply
chain.

## Ideas

`docs/roadmap.md` lists what is unfinished, including things deliberately not
done and why. The largest open item is porting to an on-device app when BUSY
ship their JS SDK — the pure modules are shaped to survive that move.

## Licence

By contributing you agree your work is licensed under the [MIT
Licence](LICENSE), the same as the rest of the project.
