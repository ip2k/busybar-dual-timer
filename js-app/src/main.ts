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
 * At most one draw may be in flight at a time, and a frame is dropped rather
 * than queued behind one.
 *
 * This is not politeness, it is a hard requirement of the runtime. Every
 * `fetch()` mallocs a `JsFetch` and starts a **dedicated FuriThread with a
 * 10 KiB stack** (`js_fetch.c`), with no pool, no queue and no cap. Firing one
 * per tick without waiting spawns threads without bound: it is what made a
 * "200ms" interval fire every ~800ms, what delayed one promise by 25 seconds,
 * and — on the evidence — what rebooted the device.
 *
 * The off-device client fires draws without awaiting, which is correct there
 * and dangerous here. Any port must serialise them like this.
 */
let drawInFlight = false;
let drawsSkipped = 0;
function draw(payload: DrawPayload, report = false): void {
  if (drawInFlight) {
    drawsSkipped++;
    return;
  }
  drawInFlight = true;
  fetch(
    new Request(`${BASE}/api/display/draw`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  )
    .then((response: { status?: number }) => {
      drawInFlight = false;
      // Only the first frame is reported. A draw that is rejected every tick
      // would otherwise bury the log, and the first one tells us what we need.
      if (report) console.info('[draw] first frame status:', String(response.status));
    })
    .catch((e: unknown) => {
      drawInFlight = false;
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

/* ----------------------------------------------------------- timing probe */

function stats(values: number[]): string {
  const sorted = values.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const total = values.reduce((a, b) => a + b, 0);
  return `n=${values.length} min=${sorted[0]} median=${median} max=${sorted[sorted.length - 1]} mean=${Math.round(total / values.length)}`;
}

/**
 * Measure what `setInterval` actually delivers, with and without a draw on each
 * tick. The off-device client ticks at 200ms and redraws whenever the frame
 * changes; whether that model survives on-device is the question, and the first
 * run suggested strongly that it does not.
 */
function measureInterval(samples: number, drawEachTick: boolean): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = Date.now();
    let n = 0;
    const handle = setInterval(() => {
      const now = Date.now();
      deltas.push(now - last);
      last = now;
      if (drawEachTick) {
        draw({
          application_name: APP_ID,
          priority: 95,
          elements: [
            {
              id: 'probe',
              type: 'text',
              x: 36,
              y: 8,
              align: 'center',
              display: 'front',
              text: String(n),
              font: 'small',
              color: '#333333FF',
            },
          ],
        });
      }
      if (++n >= samples) {
        clearInterval(handle);
        resolve(deltas);
      }
    }, TICK_MS);
  });
}

/** Round-trip time for a request that is awaited, so they never overlap. */
async function measureFetchRtt(samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = Date.now();
    try {
      await fetch(new Request(`${BASE}/api/status`, { method: 'GET' }));
    } catch (e) {
      console.error('[timing] fetch failed:', String(e));
    }
    out.push(Date.now() - started);
  }
  return out;
}

async function probeTiming(): Promise<void> {
  console.info('[timing] requested interval is', String(TICK_MS), 'ms');
  console.info('[timing] interval, no I/O:      ', stats(await measureInterval(15, false)));
  drawsSkipped = 0;
  console.info('[timing] interval, guarded draw:  ', stats(await measureInterval(15, true)));
  console.info('[timing] frames dropped for backpressure:', String(drawsSkipped), 'of 15');
  console.info('[timing] awaited fetch RTT:     ', stats(await measureFetchRtt(8)));
}

/* -------------------------------------------------------------------- run */

/** Shortened from the real defaults so a full pass takes well under a minute. */
const TIMERS: [TimerConfig, TimerConfig] = [
  { label: 'A', seconds: 8, color: '#00E5FFFF', ledColor: '#00E5FFFF' },
  { label: 'B', seconds: 5, color: '#39FF14FF', ledColor: '#39FF14FF' },
];

/**
 * How long to hold the inverting alarm. Measured in milliseconds, not ticks:
 * the first run counted 40 ticks expecting 8 seconds and got 32, because a
 * "200ms" interval actually fires roughly every 800ms on this runtime.
 */
const ALARM_MS = 6000;

/**
 * A device sound, so nothing has to be uploaded first. `POST /api/audio/play`
 * answers `200 {"result":"OK"}` even for files that do not exist, so its reply
 * proves nothing — see trap #6 in CLAUDE.md. Only a listener can confirm this.
 */
const STOCK_SOUND = 'shared/volume_change.snd';

function playChime(): void {
  fetch(
    new Request(`${BASE}/api/audio/play`, {
      method: 'POST',
      body: JSON.stringify({ application_name: APP_ID, stock_path: STOCK_SOUND }),
    }),
  )
    .then(() => {
      console.info('[audio] play requested (a 200 here means nothing; listen instead)');
    })
    .catch((e: unknown) => {
      console.error('[audio] request failed:', String(e));
    });
}

async function main(): Promise<void> {
  console.info('[dual-timer] on-device probe starting, app id', APP_ID);
  probeGlobals();
  probeLanguage();
  probeModules();
  await probeTiming();

  const timer = new DualTimer(TIMERS);
  let lastSignature = '';
  let ticks = 0;
  let finished = 0;
  let alarmStartedAt = 0;
  let lastInverted: boolean | null = null;
  let firstDrawReported = false;

  // Auto-start, because there is no way to read the buttons: the runtime has no
  // WebSocket and the HTTP API only *sends* input, never reports it. This is
  // the single blocker documented in docs/js-port.md.
  timer.toggle();
  console.info('[dual-timer] started A (no input binding exists, so this is automatic)');

  const handle = setInterval(() => {
    ticks++;

    if (timer.checkExpiry()) {
      finished++;
      alarmStartedAt = Date.now();
      console.info('[dual-timer] expired:', timer.snapshot().label);
      playChime();
    }

    const snapshot = timer.snapshot();
    const expired = snapshot.phase === 'expired';
    const alarmElapsed = expired ? Date.now() - alarmStartedAt : 0;
    const firstAlarmTick = expired && alarmElapsed < TICK_MS * 2;

    // Blink every other tick, so a full invert/normal cycle is 800ms — slow
    // enough to be seen across a room rather than read as a flicker.
    const blinkOn = Math.floor(ticks / 2) % 2 === 0;
    const inverted = expired && blinkOn;

    if (expired && inverted !== lastInverted) {
      console.info('[dual-timer] alarm phase:', inverted ? 'INVERTED' : 'normal');
      lastInverted = inverted;
    }

    const payload = buildPayload(
      { snapshot, blinkOn, alarm: expired },
      {
        applicationName: APP_ID,
        priority: 95,
        // Fire the firmware's LED notification preset on the tick the timer
        // expires. It is a one-shot three-blink, so re-sending it every frame
        // would restart it constantly; once per expiry is the whole behaviour.
        ledBlink: firstAlarmTick,
      },
    );

    const next = signature(payload);
    if (next !== lastSignature) {
      lastSignature = next;
      draw(payload, !firstDrawReported);
      firstDrawReported = true;
    }

    if (firstAlarmTick) {
      console.info('[dual-timer] LED notification requested, colour', snapshot.ledColor);
    }

    // First expiry: let the alarm run, then move to B. Second: hold, then stop.
    if (expired && alarmElapsed >= ALARM_MS) {
      if (finished === 1) {
        timer.switchTimer();
        timer.toggle();
        lastInverted = null;
        console.info('[dual-timer] switched to B and started it');
      } else {
        clearInterval(handle);
        clearDisplay();
        console.info('[dual-timer] done after', ticks, 'ticks; both timers ran to expiry');
      }
    }
  }, TICK_MS);
}

main().catch((e: unknown) => {
  console.error('[dual-timer] fatal:', String(e));
});
