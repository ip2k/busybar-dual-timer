/**
 * Offline checks. The protobuf fixtures below are real frames captured from a
 * BUSY Bar's /api/status/ws while a person tapped and held the START button.
 */
import assert from 'node:assert/strict';

import { parseInputEvents } from '../src/proto.ts';
import { GestureRecognizer, type Gesture } from '../src/gestures.ts';
import { parseState } from '../src/proto.ts';
import { decodeWav, detectFormat, ffmpegCommand, isWav, toDevicePcm } from '../src/audio.ts';
import { DualTimer } from '../src/timers.ts';
import { formatDuration, buildPayload } from '../src/render.ts';
import { generateChime } from '../src/chime.ts';

const CAPTURED = {
  startPress: 'EgZaBAoCCAI=',
  startRelease: 'EghaBgoECAIQAQ==',
  transportUpdate:
    'CQmWN2SgAQAAElIqUBohEgZsZWdhY3kaETdFOjQ1OjU4OjgzOjhDOjRCIAEoRTADIisaDTE5Mi4xNjguMS4xNjMiCzE5Mi4xNjguMS4xKg0yNTUuMjU1LjI1NS4w',
};

function decode(b64: string) {
  return parseInputEvents(new Uint8Array(Buffer.from(b64, 'base64')));
}

// 1. Real captured frames decode to the right events.
assert.deepEqual(decode(CAPTURED.startPress), [{ kind: 'button', button: 'start', action: 'press' }]);
assert.deepEqual(decode(CAPTURED.startRelease), [{ kind: 'button', button: 'start', action: 'release' }]);
// 2. Unrelated updates (here: a network-transport update) yield nothing and don't throw.
assert.deepEqual(decode(CAPTURED.transportUpdate), []);
// 3. proto3 default-omission: an entirely empty ButtonEvent is OK + PRESS.
assert.deepEqual(decode(Buffer.from([0x12, 0x04, 0x5a, 0x02, 0x0a, 0x00]).toString('base64')), [
  { kind: 'button', button: 'ok', action: 'press' },
]);
console.log('proto: ok');

// 3b. parseState exposes the device clock, which is what makes ramping robust
//     to a laggy link.
{
  const withTimestamp = Buffer.from([
    0x09, 0xed, 0x2a, 0x6c, 0x64, 0xa0, 0x01, 0x00, 0x00, // fixed64 timestamp
    0x12, 0x06, 0x5a, 0x04, 0x1a, 0x02, 0x08, 0x02, // encoder +1
  ]);
  const state = parseState(new Uint8Array(withTimestamp));
  assert.deepEqual(state.events, [{ kind: 'encoder', delta: 1 }]);
  assert.ok(state.timestampMs > 1_700_000_000_000, `device clock looked wrong: ${state.timestampMs}`);
  assert.ok(Number.isSafeInteger(state.timestampMs));
}

// 4. Gestures: START=toggle, dial click=switch, dial double-click=reset,
//    dial turn=1 minute, click+turn=fine. No ramping: one detent, one step.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seen: Gesture[] = [];
const DOUBLE_TAP_MS = 120;
const recognizer = new GestureRecognizer(
  {
    toggleButton: 'start',
    switchButton: 'ok',
    resetButton: null,
    doubleTapMs: DOUBLE_TAP_MS,
    coarseStepSeconds: 60,
    fineStepSeconds: 5,
  },
  (gesture) => seen.push(gesture),
);
const settle = () => sleep(DOUBLE_TAP_MS + 60);

// START acts on the press, with no window to wait out.
recognizer.handle('start', 'press');
assert.deepEqual(seen, [{ kind: 'toggle' }], 'START must toggle immediately on press');
recognizer.handle('start', 'release');
assert.deepEqual(seen, [{ kind: 'toggle' }], 'the release must not act again');

// BACK is unbound by default: the firmware owns it.
seen.length = 0;
recognizer.handle('back', 'press');
recognizer.handle('back', 'release');
await settle();
assert.deepEqual(seen, [], 'BACK must do nothing unless explicitly bound');

// One dial click switches, after the double-click window closes.
seen.length = 0;
recognizer.handle('ok', 'press', 1_000);
recognizer.handle('ok', 'release', 1_060);
assert.deepEqual(seen, [], 'a single click must wait to see if a second follows');
await settle();
assert.deepEqual(seen, [{ kind: 'switch' }]);

// Two quick clicks are a reset, and must NOT also switch.
seen.length = 0;
recognizer.handle('ok', 'press', 2_000);
recognizer.handle('ok', 'release', 2_060);
recognizer.handle('ok', 'press', 2_100);
recognizer.handle('ok', 'release', 2_160);
await settle();
assert.deepEqual(seen, [{ kind: 'reset' }], 'a double click must reset exactly once, with no switch');

// Network robustness: two clicks the DEVICE says were 4 s apart must be a
// switch even if a stall delivered them back-to-back. Otherwise a laggy link
// silently resets the user's timer.
seen.length = 0;
recognizer.handle('ok', 'press', 10_000);
recognizer.handle('ok', 'release', 10_060);
recognizer.handle('ok', 'press', 14_000);
recognizer.handle('ok', 'release', 14_060);
await settle();
assert.deepEqual(seen, [{ kind: 'switch' }], 'a stall must not be mistaken for a double click');

// A plain turn is one coarse step per detent, with no ramping however fast.
seen.length = 0;
recognizer.handleEncoder(1);
recognizer.handleEncoder(1);
recognizer.handleEncoder(-1);
assert.deepEqual(seen, [
  { kind: 'adjust', deltaMs: 60_000 },
  { kind: 'adjust', deltaMs: 60_000 },
  { kind: 'adjust', deltaMs: -60_000 },
], 'every detent is one step regardless of speed');

// Turning while held gives fine steps AND swallows the click.
seen.length = 0;
recognizer.handle('ok', 'press', 20_000);
recognizer.handleEncoder(1);
recognizer.handle('ok', 'release', 20_400);
await settle();
assert.deepEqual(seen, [{ kind: 'adjust', deltaMs: 5_000 }], 'click+turn must not also switch or reset');
recognizer.dispose();
console.log('gestures: ok');

// 5. Timer state machine.
const timer = new DualTimer([
  { label: 'A', seconds: 2, color: '#3BA7FFFF' },
  { label: 'B', seconds: 5, color: '#33D17AFF' },
]);
assert.equal(timer.snapshot().label, 'A');
assert.equal(timer.currentPhase, 'idle');

timer.toggle();
assert.equal(timer.currentPhase, 'running');
await sleep(300);
timer.toggle();
assert.equal(timer.currentPhase, 'paused');
const banked = timer.snapshot().remainingMs;
assert.ok(banked < 2000 && banked > 1500, `banked ${banked}ms`);

await sleep(200);
assert.equal(timer.snapshot().remainingMs, banked, 'a paused timer must not drain');

timer.switchTimer(false);
assert.equal(timer.snapshot().label, 'B');
assert.equal(timer.snapshot().remainingMs, 5000);
timer.switchTimer(false);
assert.equal(timer.snapshot().label, 'A');
assert.equal(timer.snapshot().remainingMs, banked, 'switching back restores banked time');

// Switching a RUNNING timer must stop the clock -- a defined guarantee, not an
// accident of settle(). If this ever regressed, both timers could drain at once
// and time would be attributed to whichever one you were not using.
timer.toggle();
assert.equal(timer.currentPhase, 'running');
await sleep(150);
timer.switchTimer(false);
assert.notEqual(timer.currentPhase, 'running', 'switching must never leave a timer running');
assert.equal(timer.snapshot().label, 'B');

// ...and the incoming timer must not be draining either.
const arrived = timer.snapshot().remainingMs;
await sleep(150);
assert.equal(timer.snapshot().remainingMs, arrived, 'the timer you switch TO must not auto-start');

// ...nor the one you left, when you come back to it.
timer.switchTimer(false);
assert.equal(timer.snapshot().label, 'A');
assert.notEqual(timer.currentPhase, 'running', 'switching back must not resume the clock');
const returned = timer.snapshot().remainingMs;
await sleep(150);
assert.equal(timer.snapshot().remainingMs, returned, 'the timer you return to must stay stopped');

timer.reset();

timer.reset();
assert.equal(timer.snapshot().remainingMs, 2000);
assert.equal(timer.currentPhase, 'idle');

timer.toggle();
await sleep(2100);
assert.equal(timer.checkExpiry(), true);
assert.equal(timer.currentPhase, 'expired');
assert.equal(timer.checkExpiry(), false, 'expiry fires exactly once');

// 5b. Dial adjustment.
const dial = new DualTimer([
  { label: 'A', seconds: 60, color: '#3BA7FFFF' },
  { label: 'B', seconds: 300, color: '#33D17AFF' },
]);

// While idle, adjusting sets the timer's length: remaining and total move together.
assert.equal(dial.adjust(60_000), 120_000);
let snap = dial.snapshot();
assert.equal(snap.remainingMs, 120_000);
assert.equal(snap.totalMs, 120_000, 'idle adjust must move the length too, so the bar reads full');
assert.equal(snap.fraction, 1);

// It clamps at zero rather than going negative.
assert.equal(dial.adjust(-600_000), 0);
assert.equal(dial.snapshot().totalMs, 0);

// And at the ceiling.
assert.equal(dial.adjust(999_000_000, 3_600_000), 3_600_000, 'must clamp to maxMs');

// Adjusting only touches the active timer.
dial.adjust(-3_599_000); // back to 1000ms
dial.switchTimer(false);
assert.equal(dial.snapshot().label, 'B');
assert.equal(dial.snapshot().remainingMs, 300_000, 'the other timer must be untouched');

// While running, adjusting extends the countdown in progress and keeps running.
dial.reset();
dial.toggle();
assert.equal(dial.currentPhase, 'running');
const extended = dial.adjust(60_000);
assert.ok(extended > 300_000 && extended <= 360_000, `extended to ${extended}ms`);
assert.equal(dial.currentPhase, 'running', 'adjusting must not pause a running timer');
assert.ok(dial.snapshot().fraction <= 1, 'fraction must never exceed 1 after extending');
await sleep(120);
assert.ok(dial.snapshot().remainingMs < extended, 'it must still be draining after an adjust');
console.log('timers: ok');

// 6. Rendering stays inside the 72x16 panel and formats sanely.
assert.equal(formatDuration(1500 * 1000), '25:00');
assert.equal(formatDuration(0), '00:00');
assert.equal(formatDuration(3661 * 1000), '1:01:01');
const payload = buildPayload(
  { snapshot: { index: 0, label: 'A', color: '#3BA7FFFF', phase: 'running', remainingMs: 750_000, totalMs: 1_500_000, fraction: 0.5 }, blinkOn: true },
  { applicationName: 'dual_timer', priority: 95 },
);
assert.equal(payload.priority, 95);
const bar = payload.elements.find((element) => element.id === 'bar');
assert.ok(bar && bar.type === 'rectangle' && bar.width === 36, 'half-elapsed bar should be 36px');
for (const element of payload.elements) {
  assert.ok(element.x >= 0 && element.x < 72 && element.y >= 0 && element.y < 16, `${element.id} out of bounds`);
}
// The expiry flash must emit a STABLE set of element ids. index.ts clears the
// display whenever the id set changes, and a clear leaves the device's own UI
// showing until the next draw lands -- so an id set that changed with the blink
// made the alarm strobe between DONE and the device's clock screen. Observed on
// hardware; this is the guard.
{
  const expired = {
    index: 0, label: 'A', color: '#3BA7FFFF',
    phase: 'expired' as const, remainingMs: 0, totalMs: 1_500_000, fraction: 0,
  };
  const opts = { applicationName: 'dual_timer', priority: 95 };
  const ids = (blinkOn: boolean) =>
    buildPayload({ snapshot: expired, blinkOn }, opts).elements.map((e) => e.id).sort().join(',');
  assert.equal(ids(true), ids(false), 'expiry element ids must not change with the blink');

  // Both phases must paint the full panel, so the device UI can never show
  // through even if a redraw is slow.
  for (const blinkOn of [true, false]) {
    const cover = buildPayload({ snapshot: expired, blinkOn }, opts).elements.find((e) => e.id === 'flash');
    assert.ok(cover, `expiry must always draw a covering rectangle (blinkOn=${blinkOn})`);
    assert.equal(cover.width, 72);
    assert.equal(cover.height, 16);
  }
}
console.log('render: ok');

// 7. Chime is well-formed 16-bit PCM.
const chime = generateChime();
assert.equal(chime.byteLength % 2, 0);
assert.ok(chime.byteLength > 44100, 'chime should be roughly half a second of 44.1kHz mono');
console.log('chime: ok');

// 8. WAV conversion. Build real RIFF files in memory and check we land on
//    s16le mono 44.1kHz, because that is the only thing the device plays.
function buildWav(opts: {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  format?: number;
  frames: number;
}): Uint8Array {
  const { sampleRate, channels, bitDepth, frames } = opts;
  const format = opts.format ?? 1;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames * channels; i++) {
    const value = Math.sin((i / sampleRate) * 2 * Math.PI * 440);
    const at = 44 + i * bytesPerSample;
    if (format === 3) buf.writeFloatLE(value, at);
    else if (bitDepth === 8) buf.writeUInt8(Math.round(value * 127) + 128, at);
    else if (bitDepth === 16) buf.writeInt16LE(Math.round(value * 32767), at);
    else if (bitDepth === 24) {
      const v = Math.round(value * 8388607);
      buf.writeUInt8(v & 0xff, at);
      buf.writeUInt8((v >> 8) & 0xff, at + 1);
      buf.writeInt8(v >> 16, at + 2);
    } else if (bitDepth === 32) buf.writeInt32LE(Math.round(value * 2147483647), at);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

assert.equal(isWav(buildWav({ sampleRate: 44100, channels: 1, bitDepth: 16, frames: 10 })), true);
assert.equal(isWav(generateChime()), false, 'raw PCM must not look like a WAV');

// Stereo 48kHz 16-bit: the single most likely thing someone drops in.
{
  const wav = buildWav({ sampleRate: 48000, channels: 2, bitDepth: 16, frames: 48000 });
  const { pcm, info } = decodeWav(wav);
  assert.equal(info!.channels, 2);
  assert.equal(info!.sampleRate, 48000);
  assert.equal(pcm.byteLength % 2, 0, 'output must be whole 16-bit samples');
  // 1 second in, so ~44100 mono samples out, allowing for interpolation edges.
  const samples = pcm.byteLength / 2;
  assert.ok(Math.abs(samples - 44100) <= 2, `expected ~44100 samples, got ${samples}`);
}

// 24-bit, 8-bit and 32-bit float all have to survive.
for (const spec of [
  { sampleRate: 44100, channels: 1, bitDepth: 24, frames: 4410 },
  { sampleRate: 22050, channels: 1, bitDepth: 8, frames: 2205 },
  { sampleRate: 44100, channels: 2, bitDepth: 32, format: 3, frames: 4410 },
]) {
  const { pcm } = decodeWav(buildWav(spec));
  const samples = pcm.byteLength / 2;
  assert.ok(Math.abs(samples - 4410) <= 2, `${spec.bitDepth}-bit: expected ~4410 samples, got ${samples}`);
  assert.ok(pcm.some((b) => b !== 0), `${spec.bitDepth}-bit: output must not be silence`);
}

// A compressed WAV must fail loudly rather than uploading noise.
assert.throws(
  () => decodeWav(buildWav({ sampleRate: 44100, channels: 1, bitDepth: 16, format: 17, frames: 10 })),
  /unsupported WAV encoding/,
);

// Raw PCM passes straight through, so existing setups keep working.
{
  const raw = generateChime();
  const { pcm, info } = toDevicePcm(raw);
  assert.equal(info, null);
  assert.deepEqual(pcm, raw, 'headerless PCM must be passed through untouched');
}

// Format detection works off magic bytes, not the filename -- which matters
// here, because the device's own format is a ".wav" that is not a WAV.
const magic = (bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);
assert.equal(detectFormat(buildWav({ sampleRate: 44100, channels: 1, bitDepth: 16, frames: 4 })), 'wav');
assert.equal(detectFormat(magic([0x66, 0x4c, 0x61, 0x43])), 'flac'); // "fLaC"
assert.equal(detectFormat(magic([0x4f, 0x67, 0x67, 0x53])), 'ogg'); // "OggS"
assert.equal(detectFormat(magic([0x49, 0x44, 0x33, 0x04])), 'mp3'); // "ID3"
assert.equal(detectFormat(magic([0xff, 0xfb, 0x90, 0x00])), 'mp3'); // MPEG frame sync
assert.equal(
  detectFormat(magic([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70])),
  'mp4',
); // "....ftyp"
assert.equal(
  detectFormat(magic([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 0, 0x41, 0x49, 0x46, 0x46])),
  'aiff',
); // "FORM....AIFF"
assert.equal(detectFormat(generateChime()), 'raw', 'headerless PCM must read as raw');

// The command we tell users to run must actually be the right one.
const cmd = ffmpegCommand('song.mp3');
assert.match(cmd, /-f s16le/);
assert.match(cmd, /-ac 1/);
assert.match(cmd, /-ar 44100/);
console.log('audio: ok');

console.log('\nall checks passed');
