/**
 * On-device entry point, run by the firmware's JerryScript runtime.
 *
 * This is the port probe described in `docs/js-port.md`. It does two jobs:
 *
 * 1. **Reports what the runtime actually provides.** The bindings were read out
 *    of the firmware source, but this repo's rule is that the device is the
 *    source of truth, so we ask it rather than trusting the headers.
 * 2. **Runs the real `DualTimer` and `buildPayload`.** These are imported from
 *    `src/`, not reimplemented here — the whole question this branch exists to
 *    answer is whether the pure modules survive the move, and a copy would beg
 *    that question.
 *
 * Output goes to `console`, which the firmware writes to its log. Read it back
 * over HTTP with `tools/js-app.mjs logs` — there is no serial cable involved.
 */
import { DualTimer } from '../../src/timers.ts';
import { buildPayload, signature } from '../../src/render.ts';
import type { DrawPayload } from '../../src/api.ts';
import type { TimerConfig } from '../../src/config.ts';

/** The app id, which must match both the manifest and the directory name. */
const APP_ID = 'dev.ip2k.dualtimer';

/**
 * The loopback address. A JS app has no privileged binding to the display; it
 * speaks the same HTTP API as the off-device client, just without a network in
 * between and without a token, since local requests are unauthenticated.
 */
const BASE = 'http://127.0.0.1';

const TICK_MS = 200;

/* ------------------------------------------------------------------ probe */

/**
 * `typeof` on a bare identifier is the only safe way to ask — referencing an
 * undeclared name throws, and under `JERRY_PARSE_MODULE` we are in strict mode,
 * so there is no sloppy-mode fallback to save us.
 */
function probeGlobals(): void {
  const found: string[] = [];
  const missing: string[] = [];

  const check = (name: string, present: boolean): void => {
    (present ? found : missing).push(name);
  };

  check('console', typeof console !== 'undefined');
  check('fetch', typeof fetch !== 'undefined');
  check('Request', typeof Request !== 'undefined');
  check('Headers', typeof Headers !== 'undefined');
  check('Response', typeof Response !== 'undefined');
  check('setInterval', typeof setInterval !== 'undefined');
  check('setTimeout', typeof setTimeout !== 'undefined');
  check('localStorage', typeof localStorage !== 'undefined');
  check('Promise', typeof Promise !== 'undefined');
  check('Date', typeof Date !== 'undefined');
  check('JSON', typeof JSON !== 'undefined');
  check('Math', typeof Math !== 'undefined');
  check('Uint8Array', typeof Uint8Array !== 'undefined');
  check('DataView', typeof DataView !== 'undefined');
  check('ArrayBuffer', typeof ArrayBuffer !== 'undefined');
  check('globalThis', typeof globalThis !== 'undefined');

  // The ones that decide whether a full port is possible at all.
  check('WebSocket', typeof WebSocket !== 'undefined');
  check('TextEncoder', typeof TextEncoder !== 'undefined');
  check('TextDecoder', typeof TextDecoder !== 'undefined');
  check('atob', typeof atob !== 'undefined');
  check('btoa', typeof btoa !== 'undefined');
  check('URL', typeof URL !== 'undefined');
  check('AbortController', typeof AbortController !== 'undefined');

  console.info('[probe] present:', found.join(' '));
  console.info('[probe] absent:', missing.join(' '));

  // `performance` must be reported separately, because the bundle preamble
  // installs a wall-clock fallback *before* this runs. A bare `typeof` check
  // therefore always says "present" and measures nothing but our own shim —
  // which is exactly the false positive the first run of this probe produced.
  // `__perfShimmed` is set by the preamble and is the only honest signal.
  const shimmed = (globalThis as unknown as { __perfShimmed?: boolean }).__perfShimmed;
  if (shimmed) {
    console.info('[probe] performance: ABSENT (shimmed to Date.now; no monotonic clock)');
  } else {
    // A native implementation counts from process start, so it is a small
    // number; wall time is ~1.7e12. That distinguishes the two beyond doubt.
    const now = performance.now();
    console.info('[probe] performance: native, now() =', String(Math.round(now)),
      now < 1e12 ? '(monotonic-looking)' : '(suspiciously wall-clock-like)');
  }
}

/** Language features we rely on, checked by use rather than by version number. */
function probeLanguage(): void {
  const results: string[] = [];
  const test = (name: string, fn: () => unknown): void => {
    try {
      fn();
      results.push(`${name}=ok`);
    } catch (e) {
      results.push(`${name}=FAIL`);
    }
  };

  test('class', () => new (class { x = 1 })());
  test('padStart', () => '1'.padStart(2, '0'));
  test('spread', () => ({ ...{ a: 1 } }));
  test('template', () => `x${1}`);
  test('arrow', () => (() => 1)());
  test('for-of', () => {
    for (const _ of [1]) break;
  });
  test('Map', () => new Map());
  test('Number.isFinite', () => Number.isFinite(1));
  test('toFixed', () => (1.5).toFixed(1));

  console.info('[probe] language:', results.join(' '));
}

/**
 * Static `import` of a sibling file cannot work: the runner links with a NULL
 * resolver, so nothing can load `./other.js` off the filesystem. Dynamic
 * `import()` is checked here because it fails at runtime rather than at parse
 * time, so asking costs nothing — whereas a static import of a missing module
 * would take the whole script down before any of this ran.
 */
function probeModules(): void {
  try {
    const dynamicImport = (0, eval)('typeof import === "function"');
    console.info('[probe] dynamic import():', String(dynamicImport));
  } catch (e) {
    console.info('[probe] dynamic import(): unavailable (', String(e), ')');
  }
}

/* ------------------------------------------------------------------- draw */

/**
 * Post a frame. Deliberately fire-and-forget with a `.catch`: a draw that fails
 * must not stop the countdown, exactly as in the off-device client.
 */
function draw(payload: DrawPayload): void {
  fetch(
    new Request(`${BASE}/api/display/draw`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  ).catch((e: unknown) => {
    console.error('[draw] failed:', String(e));
  });
}

function clearDisplay(): void {
  fetch(
    new Request(`${BASE}/api/display/draw?application_name=${APP_ID}`, { method: 'DELETE' }),
  ).catch(() => {
    /* nothing useful to do */
  });
}

/* -------------------------------------------------------------------- run */

const TIMERS: [TimerConfig, TimerConfig] = [
  { label: 'A', seconds: 30, color: '#00E5FFFF', ledColor: '#00E5FFFF' },
  { label: 'B', seconds: 10, color: '#39FF14FF', ledColor: '#39FF14FF' },
];

function main(): void {
  console.info('[dual-timer] on-device probe starting, app id', APP_ID);
  probeGlobals();
  probeLanguage();
  probeModules();

  const timer = new DualTimer(TIMERS);
  let lastSignature = '';
  let ticks = 0;
  let finished = 0;

  // Auto-start, because there is no way to read the buttons: the runtime has no
  // WebSocket and the HTTP API only *sends* input, never reports it. This is
  // the single blocker documented in docs/js-port.md.
  timer.toggle();
  console.info('[dual-timer] started A (no input binding exists, so this is automatic)');

  const handle = setInterval(() => {
    ticks++;

    if (timer.checkExpiry()) {
      finished++;
      console.info('[dual-timer] expired:', timer.snapshot().label, 'after', ticks, 'ticks');
      if (finished === 1) {
        timer.switchTimer();
        timer.toggle();
        console.info('[dual-timer] switched to B and started it');
      }
    }

    const snapshot = timer.snapshot();
    const payload = buildPayload(
      { snapshot, blinkOn: Math.floor(ticks / 2) % 2 === 0, alarm: snapshot.phase === 'expired' },
      { applicationName: APP_ID, priority: 95 },
    );

    const next = signature(payload);
    if (next !== lastSignature) {
      lastSignature = next;
      draw(payload);
    }

    // Stop after B has finished and had a few seconds to be seen.
    if (finished >= 2 && ticks % 5 === 0) {
      clearInterval(handle);
      clearDisplay();
      console.info('[dual-timer] done after', ticks, 'ticks; both timers ran to expiry');
    }
  }, TICK_MS);
}

main();
