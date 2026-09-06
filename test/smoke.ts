/**
 * Offline checks. The protobuf fixtures below are real frames captured from a
 * BUSY Bar's /api/status/ws while a person tapped and held the START button.
 */
import assert from 'node:assert/strict';

import { parseInputEvents } from '../src/proto.ts';
import { GestureRecognizer, type Gesture } from '../src/gestures.ts';
import { parseState } from '../src/proto.ts';
import { decodeWav, detectFormat, ffmpegCommand, isWav, toDevicePcm } from '../src/audio.ts';
import { loadConfig } from '../src/config.ts';
import { BusyBarClient, safeText } from '../src/api.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DualTimer } from '../src/timers.ts';
import { formatDuration, buildPayload } from '../src/render.ts';
import { msUntilNextTick } from '../src/clock.ts';
import { generateChime, tonesForSlot } from '../src/chime.ts';

const CAPTURED = {
  startPress: 'EgZaBAoCCAI=',
  startRelease: 'EghaBgoECAIQAQ==',
  // A network-transport update. The MAC and addresses inside it were replaced
  // byte-for-byte with documentation values (RFC 5737 / locally administered)
  // so the repo carries no real network details; the decoder skips them anyway.
  transportUpdate:
    'CQmWN2SgAQAAElIqUBohEgZsZWdhY3kaETAyOjAwOjAwOjAwOjAwOjAxIAEoRTADIisaDTIwMy4wLjExMy4xMjMiCzIwMy4wLjExMy4xKg0yNTUuMjU1LjI1NS4w',
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

// The element id set must be identical in EVERY phase, not just across the
// blink -- a change forces a clear, and the device's own UI shows in the gap.
{
  const opts = { applicationName: 'dual_timer', priority: 95 };
  const base = { index: 0, label: 'A', color: '#3BA7FFFF', ledColor: '#3BA7FFFF', totalMs: 60_000 };
  const phases = [
    { ...base, phase: 'idle' as const, remainingMs: 60_000, fraction: 1 },
    { ...base, phase: 'running' as const, remainingMs: 30_000, fraction: 0.5 },
    { ...base, phase: 'paused' as const, remainingMs: 30_000, fraction: 0.5 },
    { ...base, phase: 'running' as const, remainingMs: 0, fraction: 0 }, // empty bar
    { ...base, phase: 'expired' as const, remainingMs: 0, fraction: 0 },
  ];
  const sets = new Set<string>();
  for (const snap of phases) {
    for (const blinkOn of [true, false]) {
      const p = buildPayload({ snapshot: snap, blinkOn }, opts);
      sets.add(p.elements.map((e) => e.id).sort().join(','));
      for (const el of p.elements) {
        if (el.type === 'rectangle') {
          assert.ok(el.width >= 1, `${el.id}: rectangles must never be zero-width`);
        }
      }
    }
  }
  assert.equal(sets.size, 1, `element id set must never change; saw ${[...sets].join(' | ')}`);
}

// Per-timer LED colour. Including the field fires the firmware's Notification
// preset -- three blinks in that colour -- so the payload must carry the ACTIVE
// timer's colour, and must be absent when the caller doesn't want a blink.
{
  const opts = { applicationName: 'dual_timer', priority: 95 };
  const snap = (ledColor: string, phase: 'running' | 'idle') => ({
    index: 0, label: 'A', color: '#3BA7FFFF', ledColor,
    phase, remainingMs: 1, totalMs: 2, fraction: 0.5,
  });

  assert.equal(
    buildPayload({ snapshot: snap('#3BA7FFFF', 'running'), blinkOn: true }, { ...opts, ledBlink: true })
      .led_notification_color,
    '#3BA7FFFF',
  );
  assert.equal(
    buildPayload({ snapshot: snap('#33D17AFF', 'running'), blinkOn: true }, { ...opts, ledBlink: true })
      .led_notification_color,
    '#33D17AFF',
    'timer B must announce its own colour',
  );
  assert.equal(
    buildPayload({ snapshot: snap('#3BA7FFFF', 'running'), blinkOn: true }, { ...opts, ledBlink: false })
      .led_notification_color,
    undefined,
    'no field means the LED is left alone',
  );
}
// z_index states the layering rather than leaving it to array order, so the
// flash panel cannot end up over the time by someone reordering elementsFor.
{
  const snapshot = new DualTimer([
    { label: 'A', seconds: 60, color: '#00E5FFFF' },
    { label: 'B', seconds: 30, color: '#39FF14FF' },
  ]).snapshot();
  const payload = buildPayload({ snapshot, blinkOn: true }, { applicationName: 'x', priority: 95 });

  const z = new Map(payload.elements.map((e) => [e.id, e.z_index]));
  for (const id of ['flash', 'bar', 'label', 'time']) {
    assert.equal(typeof z.get(id), 'number', `${id} should carry a z_index`);
  }
  assert.ok(z.get('flash')! < z.get('time')!, 'the flash panel must sit behind the time');
  assert.ok(z.get('bar')! < z.get('time')!, 'the progress rule must sit behind the time');

  // Order-independent: shuffling the array must not change what is on top.
  const shuffled = [...payload.elements].reverse();
  const topmost = shuffled.reduce((a, b) => ((b.z_index ?? 0) > (a.z_index ?? 0) ? b : a));
  assert.equal(topmost.id, 'time');
}

console.log('render: ok');

// The tick loop aligns to the wall clock so a new second is drawn on the
// second, not up to TICK_MS after it.
{
  // Landing mid-period waits only the remainder.
  assert.equal(msUntilNextTick(200, 1_000_000_050), 150);
  assert.equal(msUntilNextTick(200, 1_000_000_199), 1);

  // Exactly on a boundary waits a whole period rather than firing again now.
  assert.equal(msUntilNextTick(200, 1_000_000_000), 200);

  // Whatever the starting offset, ticks converge onto multiples of the period,
  // and because 200 divides 1000 one of them lands on the second itself.
  let now = 1_700_000_000_123;
  const landings: number[] = [];
  for (let i = 0; i < 12; i++) {
    now += msUntilNextTick(200, now);
    landings.push(now % 200);
  }
  assert.deepEqual(new Set(landings), new Set([0]), 'every tick should land on a period boundary');
  assert.ok(landings.length > 0 && (now % 1000) % 200 === 0);
}

console.log('tick alignment: ok');

// 7. Chime is well-formed 16-bit PCM.
const chime = generateChime();
assert.equal(chime.byteLength % 2, 0);
assert.ok(chime.byteLength > 44100, 'chime should be roughly half a second of 44.1kHz mono');
// A and B must sound different, or the whole point is lost.
{
  const a = tonesForSlot(0), b = tonesForSlot(1);
  assert.notDeepEqual(a, b, 'timer A and B must have different tones');
  assert.notEqual(a[0]!.freq, b[0]!.freq);
  // Different contour, not just a transposition: A rises, B falls.
  assert.ok(a[a.length - 1]!.freq > a[0]!.freq, 'slot A should rise');
  assert.ok(b[b.length - 1]!.freq < b[0]!.freq, 'slot B should fall');
  assert.notEqual(generateChime(a).byteLength && Buffer.from(generateChime(a)).toString('base64'),
                  Buffer.from(generateChime(b)).toString('base64'), 'rendered audio must differ');
}
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

// 9. Config safety. Asset filenames are joined onto a directory and the result
//    is read and uploaded to the device, so a path here would let a hostile
//    config exfiltrate an arbitrary local file. Bare filenames only.
{
  const dir = mkdtempSync(join(tmpdir(), 'bdt-'));
  const write = (patch: Record<string, unknown>) => {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(patch));
    return file;
  };

  // Beyond paths: the name is also printed inside a shell command for the user
  // to copy when ffmpeg is missing, so quotes, `$`, newlines and a leading
  // dash are out too. Letters, digits, dot, dash, underscore — nothing else.
  for (const bad of [
    '../../../../etc/passwd', '/etc/passwd', 'sub/dir.wav', '..', '.hidden', '',
    'a"$(id)".mp3', "it's.mp3", '-i.wav', 'a\nb.wav', 'a b.wav', `${'a'.repeat(200)}.wav`,
  ]) {
    assert.throws(
      () => loadConfig(write({ expiry: { sound: { file: bad } } })),
      /filename|must not be empty/,
      `expiry.sound.file ${JSON.stringify(bad)} must be rejected`,
    );
  }

  // Per-timer sound files go through the same path, so they get the same guard.
  assert.throws(
    () => loadConfig(write({ timers: [{ label: 'A', seconds: 60, color: '#2B7FFFFF', sound: { file: '../x.wav' } }, { label: 'B', seconds: 60, color: '#33D17AFF' }] })),
    /bare filename/,
  );

  // stock_path is sent verbatim to the device; keep it to the documented shape.
  assert.throws(
    () => loadConfig(write({ expiry: { sound: { mode: 'stock', stockPath: '../../etc/passwd' } } })),
    /shared\/name\.snd/,
  );

  // A plain filename is still fine.
  const ok = loadConfig(write({ expiry: { sound: { file: 'chime.wav' } } }));
  assert.equal(ok.config.expiry.sound.file, 'chime.wav');
}
console.log('config safety: ok');

// 10. Hardening regressions from the 2026-09-02 security audit.
{
  const dir = mkdtempSync(join(tmpdir(), 'bdt-'));
  const write = (patch: Record<string, unknown> | string) => {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, typeof patch === 'string' ? patch : JSON.stringify(patch));
    return file;
  };
  const rejects = (label: string, patch: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => loadConfig(write(patch)), pattern, `${label} must be rejected`);
  const timers = (extra: Record<string, unknown>) => [
    { label: 'A', seconds: 60, color: '#2B7FFFFF', ...extra },
    { label: 'B', seconds: 60, color: '#33D17AFF' },
  ];

  // Types are checked, not just ranges: "60" > 0 is true in JS, which is how a
  // typo used to become behaviour.
  rejects('a numeric string', { gestures: { coarseStepSeconds: '60' } }, /must be a number/);
  rejects('a boolean string', { behavior: { resetOnSwitch: 'false' } }, /true or false/);
  rejects('NaN via string', { expiry: { flashSeconds: 'abc' } }, /must be a number/);
  rejects('negative flashSeconds', { expiry: { flashSeconds: -5 } }, /between/);
  rejects('unbounded repeat', { expiry: { sound: { repeat: 1e9 } } }, /between/);
  rejects('an object token', { device: { apiToken: { a: 1 } } }, /apiToken/);
  rejects('a host with a path', { device: { host: 'evil.example/#' } }, /device\.host/);
  rejects('a host with userinfo', { device: { host: 'user:pw@evil.example' } }, /device\.host/);
  rejects('a host with a space', { device: { host: 'bad host' } }, /device\.host/);
  rejects('a null app name', { app: { name: null } }, /app\.name/);
  rejects('a fractional priority', { app: { priority: 50.5 } }, /whole number/);
  rejects('a tone that would allocate terabytes', { timers: timers({ sound: { tones: [{ freq: 440, ms: 1e12 }] } }) }, /between/);
  rejects('a timer longer than the display can show', { timers: timers({ seconds: 1e300 }) }, /between/);
  assert.throws(() => loadConfig(write('[1, 2]')), /JSON object/);

  // Hosts that are fine.
  for (const host of ['10.0.4.20', 'busy.local', 'busy.local:8080', '[fe80::1]:80']) {
    assert.equal(loadConfig(write({ device: { host } })).config.device.host, host);
  }

  // Unknown keys are reported, not silently ignored.
  const typo = loadConfig(write({ expirey: { flashSeconds: 1 }, timers: timers({ colour: '#000000FF' }) }));
  assert.deepEqual(typo.unknownKeys, ['expirey', 'timers[0].colour']);

  // A "__proto__" key in the file must not reach any prototype chain.
  loadConfig(write('{"__proto__": {"polluted": true}}'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  // Audio bounds. A header claiming 1 Hz would expand each sample 44100x.
  assert.throws(() => decodeWav(buildWav({ sampleRate: 1, channels: 1, bitDepth: 8, frames: 200 })), /sample rate/);
  assert.throws(() => decodeWav(buildWav({ sampleRate: 8000, channels: 1, bitDepth: 8, frames: 8000 * 31 })), /too long/);
  assert.throws(() => toDevicePcm(new Uint8Array(44100 * 2 * 31)), /too long/);
  assert.ok(decodeWav(buildWav({ sampleRate: 8000, channels: 1, bitDepth: 8, frames: 8000 * 29 })).pcm.byteLength > 0);

  // The ffmpeg hint is pasted into a shell; a filename must not be able to
  // smuggle a command into it.
  const hint = ffmpegCommand(`it's "$(id)".mp3`);
  assert.ok(hint.includes(`'it'\\''s "$(id)".mp3'`), `ffmpeg hint must single-quote the path: ${hint}`);

  // A 10-byte varint is the valid encoding of any negative int32. Skipping one
  // must not kill the message it sits in.
  assert.deepEqual(
    parseInputEvents(new Uint8Array([
      0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, // field 1, varint, 10 bytes
      0x12, 0x06, 0x5a, 0x04, 0x0a, 0x02, 0x08, 0x02, // START press
    ])),
    [{ kind: 'button', button: 'start', action: 'press' }],
  );

  // Device-controlled strings are made printable before they reach a log line.
  assert.doesNotMatch(safeText('a\u001b[31mb\u0007c'), /[\u0000-\u001f]/);
  assert.equal(safeText('x'.repeat(500)).length, 201);

  // A redirect from the device is refused, never followed: following one would
  // hand the token header and the request body to whatever host it named.
  const server = createServer((_req, res) => {
    res.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let failure: Error | null = null;
  try {
    await new BusyBarClient(`127.0.0.1:${port}`, 'SECRET').version();
  } catch (error) {
    failure = error as Error;
  }
  server.close();
  assert.ok(failure, 'a redirect must be an error');
  assert.match(failure!.message, /redirect/i, `expected a redirect error, got: ${failure!.message}`);
  assert.doesNotMatch(failure!.message, /SECRET/, 'the token must not appear in the error');
}
console.log('hardening: ok');

console.log('\nall checks passed');
