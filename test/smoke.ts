/**
 * Offline checks. The protobuf fixtures below are real frames captured from a
 * BUSY Bar's /api/status/ws while a person tapped and held the START button.
 */
import assert from 'node:assert/strict';

import { parseInputEvents } from '../src/proto.ts';
import { GestureRecognizer, type Gesture } from '../src/gestures.ts';
import { parseState } from '../src/proto.ts';
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
console.log('render: ok');

// 7. Chime is well-formed 16-bit PCM.
const chime = generateChime();
assert.equal(chime.byteLength % 2, 0);
assert.ok(chime.byteLength > 44100, 'chime should be roughly half a second of 44.1kHz mono');
console.log('chime: ok');

console.log('\nall checks passed');
