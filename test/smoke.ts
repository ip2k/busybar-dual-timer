/**
 * Offline checks. The protobuf fixtures below are real frames captured from a
 * BUSY Bar's /api/status/ws while a person tapped and held the START button.
 */
import assert from 'node:assert/strict';

import { parseInputEvents } from '../src/proto.ts';
import { GestureRecognizer, type Gesture } from '../src/gestures.ts';
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

// 4. Gestures: three quick taps must resolve to a reset, a hold to a long press.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seen: Gesture[] = [];
const recognizer = new GestureRecognizer(
  { button: 'start', longPressMs: 300, multiTapWindowMs: 200, tapMode: 'deferred', resetTapCount: 3 },
  (gesture) => seen.push(gesture),
);

for (let i = 0; i < 3; i++) {
  recognizer.handle('start', 'press');
  await sleep(60);
  recognizer.handle('start', 'release');
  await sleep(60);
}
await sleep(300);
assert.deepEqual(seen, [{ kind: 'reset' }], `expected one reset, got ${JSON.stringify(seen)}`);

seen.length = 0;
recognizer.handle('start', 'press');
await sleep(400);
assert.deepEqual(seen, [{ kind: 'longPress' }]);
recognizer.handle('start', 'release');
await sleep(300);
assert.deepEqual(seen, [{ kind: 'longPress' }], 'release after a hold must not also register a tap');

seen.length = 0;
recognizer.handle('start', 'press');
await sleep(50);
recognizer.handle('start', 'release');
await sleep(300);
assert.deepEqual(seen, [{ kind: 'tap', count: 1 }]);
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
