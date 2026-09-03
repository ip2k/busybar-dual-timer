import { readFileSync } from 'node:fs';
import type { SwitchPosition } from './proto.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ButtonName = 'ok' | 'back' | 'start';
export type SoundMode = 'asset' | 'stock' | 'none';
export type LedMode = 'off' | 'transitions' | 'running';

/** A tone in the synthesised chime. */
export interface ToneConfig {
  freq: number;
  ms: number;
  gain?: number;
}

export interface TimerConfig {
  label: string;
  seconds: number;
  color: string;
  /**
   * Colour to blink the status LED while this timer is the active one, so you
   * can tell A from B without reading the panel. Defaults to `color`.
   *
   * The firmware only exposes a colour — the blink pattern is its own and
   * cannot be configured.
   */
  ledColor?: string;
  /**
   * This timer's expiry sound, so A and B are audibly different. Either a file
   * in `assets/`, or tones to synthesise. Defaults to a distinct built-in tone
   * per slot.
   */
  sound?: { file?: string; tones?: ToneConfig[] };
}

export interface Config {
  device: { host: string; apiToken: string | null };
  app: { name: string; priority: number };
  timers: [TimerConfig, TimerConfig];
  gestures: {
    toggleButton: ButtonName;
    /** Pressing the dial in; on this hardware that is the `ok` button. */
    switchButton: ButtonName;
    /**
     * Extra button bound to reset. **Defaults to null (unbound)** — the only
     * spare button is BACK, and the firmware uses it to pop its own navigation
     * stack, which throws the widget off the panel. Reset is a double-click of
     * the dial instead. Set this only if you have a reason to.
     */
    resetButton: ButtonName | null;
    /** Two dial clicks within this window mean reset rather than two switches. */
    doubleTapMs: number;
    /** Step for a plain dial turn. */
    coarseStepSeconds: number;
    /** Step for a turn with the dial held down. */
    fineStepSeconds: number;
    /** Upper bound the dial can wind a timer to. */
    maxSeconds: number;
  };
  behavior: {
    resetOnSwitch: boolean;
    autoAdvanceOnExpiry: boolean;
    streamFrames: boolean;
    startPaused: boolean;
    /**
     * Drop a single stream message carrying more input events than this. The
     * device has been seen replaying a large backlog at once, which would fire
     * dozens of toggles and resets. 0 disables the guard.
     */
    maxEventsPerMessage: number;
    /**
     * Redraw at least this often even when nothing changed, to reclaim the
     * screen after the firmware navigates away on its own (BACK exits to the
     * device UI). 0 disables it.
     */
    reassertEveryMs: number;
    /**
     * How to drive the START button LED.
     *
     * The HTTP API reaches exactly one of the firmware's light presets:
     * `Notification`, which is **three blinks at maximum brightness** in a
     * colour of your choosing. There is no steady-on and no pattern control —
     * see `docs/busy-bar-api.md`.
     *
     * - `running`   re-fire it on every redraw while a timer runs, which reads
     *               as continuous flashing in that timer's colour.
     * - `transitions` fire it once when something happens — started, switched,
     *               expired — so you get three clean blinks and then quiet.
     *               Closer to what a "notification" preset is for.
     * - `off`       never touch the LED.
     */
    ledMode: LedMode;
    /**
     * Only show the widget when the physical lever is in this position, so the
     * lever picks between the device's own apps and this timer.
     *
     * `null` (the default) means always show it, whatever the lever is doing.
     *
     * Caveat worth knowing: the lever position is only reported when it
     * *changes* — no endpoint exposes it, checked. So on startup the position is
     * unknown, and the widget stays hidden until the lever moves at least once.
     */
    activeSwitchPosition: SwitchPosition | null;
  };
  expiry: {
    flashSeconds: number;
    flashHz: number;
    ledColor: string;
    sound: {
      mode: SoundMode;
      file: string;
      stockPath: string | null;
      repeat: number;
      repeatEveryMs: number;
    };
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const DEFAULTS: Config = {
  // Overridden by config.json. 10.0.4.20 is the Bar's fixed USB address, which
  // works with no token and no network setup — the best default for a first run.
  device: { host: '10.0.4.20', apiToken: null },
  app: { name: 'dual_timer', priority: 95 },
  timers: [
    { label: 'A', seconds: 1500, color: '#3BA7FFFF' },
    { label: 'B', seconds: 300, color: '#33D17AFF' },
  ],
  gestures: {
    toggleButton: 'start',
    switchButton: 'ok',
    resetButton: null,
    // Measured on hardware: rapid clicks run 147-182 ms apart, so 300 ms is a
    // comfortable window without making a single click feel sluggish.
    doubleTapMs: 300,
    coarseStepSeconds: 60,
    fineStepSeconds: 5,
    maxSeconds: 24 * 60 * 60,
  },
  behavior: {
    resetOnSwitch: false,
    autoAdvanceOnExpiry: false,
    streamFrames: true,
    startPaused: true,
    maxEventsPerMessage: 8,
    reassertEveryMs: 2000,
    ledMode: 'running',
    activeSwitchPosition: null,
  },
  expiry: {
    flashSeconds: 10,
    flashHz: 0, // 0 = hold DONE steady; >0 strobes at that rate
    ledColor: '#FF3B30FF',
    sound: { mode: 'asset', file: 'chime.wav', stockPath: null, repeat: 3, repeatEveryMs: 1200 },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge user config over defaults so a partial config file still works. */
function merge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? merge(current, value) : value;
  }
  return out as T;
}

const HEX_RGBA = /^#[0-9a-fA-F]{8}$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`config: ${message}`);
}

function validate(cfg: Config): void {
  assert(typeof cfg.device.host === 'string' && cfg.device.host.length > 0, 'device.host is required');
  assert(Array.isArray(cfg.timers) && cfg.timers.length === 2, 'timers must contain exactly two entries');
  for (const [i, timer] of cfg.timers.entries()) {
    assert(Number.isFinite(timer.seconds) && timer.seconds > 0, `timers[${i}].seconds must be > 0`);
    assert(typeof timer.label === 'string' && timer.label.length > 0, `timers[${i}].label is required`);
    assert(HEX_RGBA.test(timer.color), `timers[${i}].color must be #RRGGBBAA`);
    if (timer.ledColor !== undefined) {
      assert(HEX_RGBA.test(timer.ledColor), `timers[${i}].ledColor must be #RRGGBBAA`);
    }
    if (timer.sound?.tones !== undefined) {
      assert(
        Array.isArray(timer.sound.tones) && timer.sound.tones.length > 0,
        `timers[${i}].sound.tones must be a non-empty array`,
      );
      for (const [j, tone] of timer.sound.tones.entries()) {
        assert(tone.freq > 0, `timers[${i}].sound.tones[${j}].freq must be > 0`);
        assert(tone.ms > 0, `timers[${i}].sound.tones[${j}].ms must be > 0`);
      }
    }
  }
  assert(
    cfg.app.priority >= 1 && cfg.app.priority <= 100,
    'app.priority must be 1-100 (system apps sit at 10, an active BUSY session at 90)',
  );
  const buttons = ['ok', 'back', 'start'];
  const bound: [string, ButtonName | null][] = [
    ['toggleButton', cfg.gestures.toggleButton],
    ['switchButton', cfg.gestures.switchButton],
    ['resetButton', cfg.gestures.resetButton],
  ];
  for (const [key, value] of bound) {
    if (key === 'resetButton' && value === null) continue;
    assert(value !== null && buttons.includes(value), `gestures.${key} must be 'ok', 'back' or 'start'`);
  }
  const assigned = bound.map(([, value]) => value).filter((value) => value !== null);
  assert(
    new Set(assigned).size === assigned.length,
    'gestures.toggleButton, switchButton and resetButton must all be different buttons',
  );
  assert(cfg.gestures.doubleTapMs > 50, 'gestures.doubleTapMs must be > 50');
  assert(cfg.gestures.coarseStepSeconds > 0, 'gestures.coarseStepSeconds must be > 0');
  assert(cfg.gestures.fineStepSeconds > 0, 'gestures.fineStepSeconds must be > 0');
  assert(cfg.gestures.maxSeconds > 0, 'gestures.maxSeconds must be > 0');
  if (cfg.behavior.activeSwitchPosition !== null) {
    assert(
      ['busy', 'custom', 'off', 'apps', 'settings'].includes(cfg.behavior.activeSwitchPosition),
      "behavior.activeSwitchPosition must be null or one of 'busy', 'custom', 'off', 'apps', 'settings'",
    );
  }
  assert(
    ['off', 'transitions', 'running'].includes(cfg.behavior.ledMode),
    "behavior.ledMode must be 'off', 'transitions' or 'running'",
  );
  assert(cfg.behavior.reassertEveryMs >= 0, 'behavior.reassertEveryMs must be >= 0 (0 disables it)');
  assert(cfg.behavior.maxEventsPerMessage >= 0, 'behavior.maxEventsPerMessage must be >= 0 (0 disables the guard)');
  assert(cfg.expiry.flashHz >= 0, 'expiry.flashHz must be >= 0 (0 holds DONE steady)');
  assert(HEX_RGBA.test(cfg.expiry.ledColor), 'expiry.ledColor must be #RRGGBBAA');
  assert(['asset', 'stock', 'none'].includes(cfg.expiry.sound.mode), "expiry.sound.mode must be 'asset', 'stock' or 'none'");
  if (cfg.expiry.sound.mode === 'stock') {
    assert(!!cfg.expiry.sound.stockPath, "expiry.sound.stockPath is required when sound.mode is 'stock'");
  }
}

export function loadConfig(path?: string): Config {
  const file = resolve(path ?? process.env.BUSY_TIMER_CONFIG ?? `${PROJECT_ROOT}/config.json`);
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw new Error(`config: could not read ${file}: ${err.message}`);
    console.warn(`[config] ${file} not found, using built-in defaults`);
  }
  const cfg = merge(DEFAULTS, raw);
  validate(cfg);
  return cfg;
}

export { PROJECT_ROOT };
