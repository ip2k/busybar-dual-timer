# Custom sounds

How to make the timer play your own sound when it expires, and how to work out
what went wrong when it doesn't.

## The short version

```bash
cp ~/Music/ding.mp3 assets/chime.wav
npm run dev
```

That's it. The file is converted for you. The name has to match
`expiry.sound.file` in your config (which defaults to `chime.wav`), but the
*contents* can be an MP3, a FLAC, a stereo 48 kHz WAV — whatever you have. The
extension is ignored; the file is identified by its actual contents.

You should see, on startup:

```
[sound] chime.wav: 2ch -> mono, 48000Hz -> 44100Hz, stripped RIFF header
[sound] source was 48000Hz 2ch 16-bit, 1.50s
[sound] uploaded chime.wav (132300 bytes) to app 'dual_timer'
```

If you'd rather not touch the config at all, just delete the file — the timer
falls back to a synthesised chime with no setup.

## Why a conversion step exists at all

The Bar does not play audio files. It plays **raw PCM**: signed 16-bit
little-endian, mono, 44100 Hz, with **no header**. Confusingly, the API wants
that uploaded under a `.wav` filename — so a "`.wav`" here is not a WAV file at
all.

Hand it a real WAV and the RIFF header is interpreted as audio. You get a click
of noise, or silence, and — this is the part that wastes an afternoon — the API
returns `200 {"result":"OK"}` either way. It returns `200` for files that do not
exist. **The status code tells you nothing.** See `docs/busy-bar-api.md`.

So this project converts for you rather than making that your problem.

## What's supported, and how

Two paths, depending on the format:

| Format | Handled by | Needs ffmpeg |
| --- | --- | --- |
| WAV — PCM 8/16/24/32-bit, float 32/64-bit, any rate, any channels | built in | no |
| Raw PCM (already s16le mono 44.1 kHz) | passed straight through | no |
| MP3, FLAC, OGG, M4A/AAC, AIFF | ffmpeg | yes |

WAV is handled in-process: channels are averaged to mono, samples are resampled
to 44.1 kHz by linear interpolation, and everything is converted to 16-bit.
No dependencies, no external tools.

Compressed formats genuinely need a decoder, which is far more code than this
project's zero-dependency rule allows. If `ffmpeg` is on your `PATH` it is used
automatically. If it isn't, you get told exactly what to run.

### Installing ffmpeg

```bash
# macOS
brew install ffmpeg

# Debian / Ubuntu / Raspberry Pi OS
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg
```

### Converting by hand

You never need to do this — but if you want to prepare a file yourself, or you
can't install ffmpeg on the machine running the timer:

```bash
ffmpeg -i input.mp3 -f s16le -acodec pcm_s16le -ac 1 -ar 44100 assets/chime.wav
```

Each flag matters:

| Flag | Why |
| --- | --- |
| `-f s16le` | raw output, **no header** — this is the crucial one |
| `-acodec pcm_s16le` | signed 16-bit little-endian samples |
| `-ac 1` | mono |
| `-ar 44100` | 44.1 kHz |

The result is headerless PCM. Drop it in `assets/` and it's passed through
untouched.

## Choosing a good sound

- **Keep it short.** One to two seconds. The device's own notification sounds
  are 0.5 s and 1.5 s.
- **Loud and bright beats subtle.** It's a small speaker in a room where you
  are, by definition, not paying attention.
- **Mind the repeats.** `expiry.sound.repeat` plays it several times
  `repeatEveryMs` apart. A two-second sound repeated three times at 1200 ms
  overlaps itself.

Sanity check on length: at 44.1 kHz mono 16-bit, **one second is 88200 bytes**.
If the upload log says 132300 bytes, that's exactly 1.5 seconds.

## Configuration

```json
"expiry": {
  "sound": {
    "mode": "asset",
    "file": "chime.wav",
    "stockPath": null,
    "repeat": 3,
    "repeatEveryMs": 1200
  }
}
```

| Key | Meaning |
| --- | --- |
| `mode: "asset"` | upload and play your file from `assets/` |
| `mode: "stock"` | play one of the device's built-in sounds — set `stockPath` |
| `mode: "none"` | silent; the display still flashes |
| `file` | filename inside `assets/`, and the name it's uploaded under |
| `repeat` | how many times to play on expiry |
| `repeatEveryMs` | gap between repeats |

### Using the device's own sounds

No upload, no conversion, nothing to install:

```json
"sound": { "mode": "stock", "stockPath": "shared/volume_change.snd" }
```

The stock sounds are:

| `stockPath` | Length |
| --- | --- |
| `shared/volume_change.snd` | 0.5 s |
| `shared/calendar_event_starts.snd` | 1.5 s |
| `shared/calendar_reminder_ends.snd` | 1.5 s |

## Troubleshooting

### I hear nothing

Work down this list — it's ordered by how often each one is the culprit.

**1. Check the device volume.** Nothing else matters if this is zero.

```bash
curl http://<bar>/api/audio/volume
```

**2. Confirm the file actually reached the device**, and check its size. The
upload response is as uninformative as the playback one, so ask the filesystem:

```bash
curl "http://<bar>/api/storage/list?path=/ext/user_assets/dual_timer"
```

You want your file, at a plausible size (88200 bytes per second). If it's absent,
the upload failed. If it's suspiciously small, the conversion did.

**3. Test the audio path with a stock sound.** This isolates "the device can make
noise at all" from "my file is wrong":

```bash
curl -X POST http://<bar>/api/audio/play \
  -H 'Content-Type: application/json' \
  -d '{"application_name":"dual_timer","stock_path":"shared/volume_change.snd"}'
```

If you hear that but not your file, the problem is your file. If you hear
neither, it's volume or the device.

**4. Play your own file directly**, skipping the timer entirely:

```bash
curl -X POST http://<bar>/api/audio/play \
  -H 'Content-Type: application/json' \
  -d '{"application_name":"dual_timer","path":"chime.wav"}'
```

**5. Read the startup log.** It says what conversion happened. No `[sound]` line
mentioning your file means it wasn't found and the built-in chime was used —
check the filename matches `expiry.sound.file` exactly.

Remember throughout: **every one of these calls returns `200 OK` regardless.**
Judge by what you hear and by the file listing, never by the status code.

### "needs decoding this project cannot do on its own"

Your file is compressed and `ffmpeg` isn't installed. Install it, or convert by
hand with the command above.

### "unsupported WAV encoding (format N)"

A compressed WAV — usually ADPCM. Re-export as plain 16-bit PCM, or run it
through ffmpeg.

### It plays, but sounds like static

Almost certainly a real audio file uploaded without conversion — the header
being played as samples. If you converted by hand, check you used `-f s16le` and
not just an output filename ending in `.wav`: **`ffmpeg` picks its muxer from the
extension**, so `output.wav` writes a real WAV with a header. That single flag is
the whole difference.
