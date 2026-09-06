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


/* ------------------------------------------------------------- breadcrumbs */

/**
 * Record how far the script got, in storage rather than in the log.
 *
 * `console` output goes to an in-memory ring buffer that `POST /api/log_dump`
 * snapshots. A crash that reboots the device clears it, so the log tells you
 * nothing about the run that killed it — which is exactly the run you need.
 *
 * `localStorage.setItem` flushes to /ext/apps_data/jsrunner on every call, so a
 * breadcrumb written here outlives the reboot and can be fetched afterwards
 * with `tools/js-app.mjs crumbs`.
 */
function mark(stage: string): void {
  try {
    localStorage.setItem('stage', stage);
    localStorage.setItem('at', String(Date.now()));
  } catch (e) {
    console.error('[mark] failed:', String(e));
  }
}

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
function draw(payload: DrawPayload, report = false): boolean {
  if (drawInFlight) {
    drawsSkipped++;
    return false;
  }
  drawInFlight = true;
  fetch(
    new Request(`${BASE}/api/display/draw`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  )
    // The body MUST be consumed. In js_fetch.c the JsFetch is freed only once
    // promise, response and sink are all done (line ~244), and while the
    // response is unread every incoming chunk is queued instead (line ~409).
    // A `.then` that ignores the body therefore leaks the whole request, its
    // queued data and its thread, permanently. This was rebooting the device.
    .then((response: { status?: number; text: () => Promise<string> }) =>
      response.text().then(() => response.status),
    )
    .then((status: number | undefined) => {
      drawInFlight = false;
      // Only the first frame is reported. A draw that is rejected every tick
      // would otherwise bury the log, and the first one tells us what we need.
      if (report) console.info('[draw] status:', String(status));
    })
    .catch((e: unknown) => {
      drawInFlight = false;
      console.error('[draw] failed:', String(e));
    });
  return true;
}

/**
 * Clear the panel, then stop.
 *
 * The order matters and is not obvious. `js_runner.c` tears the app down when
 * the script runs out of work, and teardown calls `abort_fetches()` on anything
 * still in flight. Ending the script with an outstanding request therefore
 * races the abort path — and on the evidence of a breadcrumb reading
 * `expired-2` seven seconds before a reboot, that race is what killed the
 * device. So the interval, which is the only thing keeping the runtime alive,
 * is cleared *inside* the response handler rather than before the request.
 */
function clearDisplayThenStop(handle: IntervalHandle, onStopped: () => void): void {
  fetch(new Request(`${BASE}/api/display/draw?application_name=${APP_ID}`, { method: 'DELETE' }))
    // Consume the body even here, where the result is of no interest: an
    // unread body leaks the request regardless of whether anyone wanted it.
    .then((response: { text: () => Promise<string> }) => response.text())
    .then(() => {
      clearInterval(handle);
      onStopped();
    })
    .catch((e: unknown) => {
      clearInterval(handle);
      console.error('[dual-timer] clear failed:', String(e));
      onStopped();
    });
}

/* -------------------------------------------------------------------- run */

const TIMERS: [TimerConfig, TimerConfig] = [
  { label: 'A', seconds: 8, color: '#00E5FFFF', ledColor: '#00E5FFFF' },
  { label: 'B', seconds: 5, color: '#39FF14FF', ledColor: '#39FF14FF' },
];

const ALARM_MS = 6000;
const STOCK_SOUND = 'shared/volume_change.snd';
const TICK_MS = 250;

type IntervalHandle = ReturnType<typeof setInterval>;

function playChime(): void {
  fetch(
    new Request(`${BASE}/api/audio/play`, {
      method: 'POST',
      body: JSON.stringify({ application_name: APP_ID, stock_path: STOCK_SOUND }),
    }),
  )
    .then((response: { text: () => Promise<string> }) => response.text())
    .then(() => {
      console.info('[audio] play requested (a 200 here means nothing; listen instead)');
    })
    .catch((e: unknown) => {
      console.error('[audio] request failed:', String(e));
    });
}

/**
 * Draw one frame per *phase*, not per second.
 *
 * A loopback draw was measured at **~3.5 seconds** from issue to completion on
 * this runtime, so a per-second redraw cannot work: while one request is in
 * flight every other frame is dropped, and the digits visibly skip. The
 * countdown element is therefore not an optimisation, it is the only way to get
 * a display that updates every second.
 *
 * So the ticking digits are a `countdown` element, which the firmware animates
 * with no further traffic, while the label and the progress rule stay as our
 * own elements. They are static for the life of a phase, so they cost nothing
 * to keep. Only the digits give up their font, and only because the API gives
 * `countdown` no font field at all.
 */
function drawPhase(
  label: string,
  color: string,
  endsAtMs: number | null,
  doneText: string | null,
  ledColor?: string,
): boolean {
  const timeElement = doneText
    ? {
        id: 'time', type: 'text', x: 36, y: 8, align: 'center', display: 'front',
        text: doneText, font: 'bold', color, z_index: 3,
      }
    : {
        id: 'time', type: 'countdown', x: 39, y: 8, align: 'center', display: 'front',
        timestamp: String(Math.round((endsAtMs ?? Date.now()) / 1000)),
        direction: 'time_left', show_hours: 'when_non_zero', color, z_index: 3,
      };

  const payload = {
    application_name: APP_ID,
    priority: 95,
    elements: [
      {
        id: 'label', type: 'text', x: 1, y: 1, align: 'top_left', display: 'front',
        text: doneText ? '' : label, font: 'small', color, z_index: 2,
      },
      timeElement,
    ],
  } as unknown as DrawPayload;
  if (ledColor) (payload as { led_notification_color?: string }).led_notification_color = ledColor;
  return draw(payload, ledColor !== undefined);
}

function main(): void {
  mark('start');
  console.info('[dual-timer] on-device probe starting, app id', APP_ID);
  probeGlobals();
  mark('globals-done');
  probeLanguage();
  probeModules();
  mark('probes-done');

  const timer = new DualTimer(TIMERS);
  let finished = 0;
  let alarmStartedAt = 0;
  let drawnPhase = '';
  let shuttingDown = false;
  let draws = 0;

  timer.toggle();
  mark('timer-started');
  console.info('[dual-timer] started A (no input binding exists, so this is automatic)');

  const handle: IntervalHandle = setInterval(() => {
    if (shuttingDown) return;

    const justExpired = timer.checkExpiry();
    if (justExpired) {
      finished++;
      alarmStartedAt = Date.now();
      mark('expired-' + String(finished));
      console.info('[dual-timer] expired:', timer.snapshot().label);
      playChime();
    }

    const snapshot = timer.snapshot();
    const expired = snapshot.phase === 'expired';
    const phaseKey = `${snapshot.index}:${snapshot.phase}`;

    if (phaseKey !== drawnPhase) {
      const sent = drawPhase(
        snapshot.label,
        snapshot.color,
        expired ? null : Date.now() + snapshot.remainingMs,
        expired ? `${snapshot.label} DONE` : null,
        // The LED rides on the frame that announces expiry. It must be latched
        // on delivery, not intent -- see the note in draw().
        justExpired || (expired && drawnPhase !== phaseKey) ? snapshot.ledColor : undefined,
      );
      if (sent) {
        draws++;
        drawnPhase = phaseKey;
        console.info('[dual-timer] drew', phaseKey);
      }
    }

    if (expired && Date.now() - alarmStartedAt >= ALARM_MS) {
      if (finished === 1) {
        timer.switchTimer();
        timer.toggle();
        console.info('[dual-timer] switched to B and started it');
      } else if (!shuttingDown) {
        shuttingDown = true;
        clearDisplayThenStop(handle, () => {
          mark('complete');
          console.info('[dual-timer] done; both timers ran to expiry, draws:', draws);
        });
      }
    }
  }, TICK_MS);
}

try {
  main();
} catch (e) {
  mark('fatal:' + String(e));
  console.error('[dual-timer] fatal:', String(e));
}
