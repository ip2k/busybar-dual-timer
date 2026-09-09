# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/ip2k/busybar-dual-timer/security/advisories/new)
rather than a public issue. If that isn't available to you, open a normal issue
saying only that you have a security report and asking for a contact — please
don't include details in it.

## What this program does on your machine

Worth stating plainly, since it runs on your computer and talks to a device on
your network.

**It makes network calls to exactly one host: the Bar you configured.** There
are two, both built from `device.host`:

- `node:http` requests to `http://<device.host>/api/...`
- a WebSocket to `ws://<device.host>/api/status/ws`

There is no telemetry, no update check, and no third-party endpoint. You can
confirm this in `src/api.ts` — those are the only two call sites in the
codebase.

**It refuses HTTP redirects.** The Bar never redirects, and following one
would send the token header and the request body to whatever host the
response named — on plain HTTP, that is anyone on the path, not only the
device. `node:http` does not follow redirects on its own, and any 3xx is
turned into a failed request rather than a new destination. There is a test
for it.

**It caps what the device can say.** A response body is read to the end in
memory, so a reply is refused past 1 MB rather than being allowed to grow the
process's heap without bound. Every real endpoint answers in tens of bytes.

**It has zero runtime dependencies.** Nothing is pulled in at install time, so
there is no transitive package surface. `npm audit` reports nothing because
there is nothing to report.

**It runs one external program, and only if you ask.** If a sound file needs
decoding — mp3, flac, ogg, m4a, aiff — `ffmpeg` is invoked *if it is already
installed*. It is called with an argument array, never through a shell, so a
filename cannot inject a command. WAV and raw PCM are handled in-process with
no external tools.

**It writes to disk only where you point it.** `--init` writes `config.json` and
an `assets/` directory into the current directory, and refuses to overwrite an
existing config.

**It changes one device-wide setting.** With `display.brightness` set, the
Bar's brightness is changed and the previous value restored on a clean
shutdown. A hard kill skips the restore. Set it to `null` to leave the device's
settings alone entirely.

## Your API token

Over Wi-Fi the Bar requires a password, which this program sends on every
request.

- **It lives in plaintext in `config.json`.** Treat that file like any other
  credential file — `config.json` is gitignored here, and the published npm
  package and release tarballs contain only `config.example.json`.
- **It is never logged.** The token is read into a header and never printed,
  including in error messages. Strings that come *from* the device — error
  bodies, its version — are stripped of control characters and capped before
  they reach a log line, so the Bar cannot write escape sequences into your
  terminal or journal either.
- **`--init` writes `config.json` owner-only (mode 0600)**, since that is
  where the token goes.
- **It travels in cleartext on your LAN.** The Bar's local API is plain HTTP,
  not HTTPS — that is the device's design, not a choice this program makes. On
  a network you don't trust, prefer the USB connection (`10.0.4.20`), which
  needs no token at all.
- **The WebSocket carries it as a query parameter** (`?x-api-token=...`),
  because that is what the firmware accepts; the HTTP API uses a header. Query
  strings are the sort of thing intermediaries log, which is another reason not
  to run this across a network you don't control.
- **It is sent to whatever `device.host` says.** Point that at a host you don't
  own and you have handed them your token. Only configure Bars you control.

## Config is trusted input, within limits

`config.json` is your file, so it is trusted — but not blindly, since a config
could arrive from somewhere else:

- **Asset filenames must be plain filenames** — letters, digits, dot, dash and
  underscore, not starting with a dot or dash. `expiry.sound.file` and
  `timers[].sound.file` are joined onto a directory and the result is read and
  uploaded to the Bar. Without a check, `../../../../etc/passwd` or an absolute
  path would escape and send that file's contents to the device. The name is
  also printed inside a shell command for you to copy when ffmpeg is missing,
  which is why quotes and `$` are refused as well. There is a test for it.
- **Sound files are bounded.** At most 8 MB on disk and 30 seconds of audio,
  with a sample rate between 8 kHz and 192 kHz. The WAV header is untrusted
  input that sizes memory allocations: a 20 KB file claiming a 1 Hz sample
  rate used to expand into 1.7 GB of PCM. ffmpeg is run with `-t 30` for the
  same reason.
- **`stockPath` must match `shared/<name>`**, the shape the firmware documents,
  rather than being passed through to arbitrary device paths.
- **Every value is type-checked, not just range-checked.** A string where a
  number belongs is an error, not a coercion, and the host must look like
  `host` or `host:port`. Unknown keys are reported at startup so a typo cannot
  silently do nothing.
- The program exits rather than starting with a config it doesn't understand.

## Supply chain

- Releases are built and published by GitHub Actions, never from a laptop.
- npm publishing uses **trusted publishing (OIDC)**: the registry trusts this
  repository and workflow directly, so no npm credential is stored in the
  repository at all. There is no token to leak or rotate.
- The npm package is published with **provenance**, so npm shows a verifiable
  link to the exact commit and workflow run that produced it.
- Workflows use only `actions/checkout` and `actions/setup-node`, pinned to
  commit SHAs, plus the `gh` CLI preinstalled on runners. No third-party
  actions.
- CI runs with a read-only token. Only the release job can write, and it needs
  `contents: write` to push a tag and `id-token: write` for provenance.
- Nothing from the triggering event is expanded into a shell script. Tag names
  and dispatch inputs reach the release job through environment variables and
  must match `vX.Y.Z` / `patch|minor|major|X.Y.Z` before anything runs.
- Release artifacts ship with a `.sha256`.
