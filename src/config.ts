import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ButtonName = 'ok' | 'back' | 'start';
export type SoundMode = 'asset' | 'stock' | 'none';

export interface TimerConfig {
  label: string;
  seconds: number;
  color: string;
}

export interface Config {
  device: { host: string; apiToken: string | null };
  app: { name: string; priority: number };
  timers: [TimerConfig, TimerConfig];
  gestures: {
    toggleButton: ButtonName;
    resetButton: ButtonName;
    /** Pressing the dial in; on this hardware that is the `ok` button. */
    switchButton: ButtonName;
    /** Step for a plain dial turn. */
    coarseStepSeconds: number;
    /** Step for a turn with the dial held down. */
    fineStepSeconds: number;
    /** Spinning faster multiplies the step. */
    ramp: {
      fastGapMs: number;
      fastMultiplier: number;
      mediumGapMs: number;
      mediumMultiplier: number;
    };
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
  device: { host: '192.168.1.163', apiToken: null },
  app: { name: 'dual_timer', priority: 95 },
  timers: [
    { label: 'A', seconds: 1500, color: '#3BA7FFFF' },
    { label: 'B', seconds: 300, color: '#33D17AFF' },
  ],
  gestures: {
    toggleButton: 'start',
    resetButton: 'back',
    switchButton: 'ok',
    coarseStepSeconds: 60,
    fineStepSeconds: 5,
    // Measured on hardware. A deliberate spin sits around 56-83 ms between
    // detents, so those thresholds must be BELOW that or ordinary spinning
    // ramps to the top multiplier immediately. x5 is reserved for a genuine
    // flick (<25 ms); normal spinning lands on x2.
    ramp: { fastGapMs: 25, fastMultiplier: 5, mediumGapMs: 100, mediumMultiplier: 2 },
    maxSeconds: 24 * 60 * 60,
  },
  behavior: {
    resetOnSwitch: false,
    autoAdvanceOnExpiry: false,
    streamFrames: true,
    startPaused: true,
    maxEventsPerMessage: 8,
    reassertEveryMs: 2000,
  },
  expiry: {
    flashSeconds: 10,
    flashHz: 3,
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
  }
  assert(
    cfg.app.priority >= 1 && cfg.app.priority <= 100,
    'app.priority must be 1-100 (system apps sit at 10, an active BUSY session at 90)',
  );
  const buttons = ['ok', 'back', 'start'];
  const bound = [
    ['toggleButton', cfg.gestures.toggleButton],
    ['resetButton', cfg.gestures.resetButton],
    ['switchButton', cfg.gestures.switchButton],
  ] as const;
  for (const [key, value] of bound) {
    assert(buttons.includes(value), `gestures.${key} must be 'ok', 'back' or 'start'`);
  }
  assert(
    new Set(bound.map(([, value]) => value)).size === bound.length,
    'gestures.toggleButton, resetButton and switchButton must all be different buttons',
  );
  assert(cfg.gestures.coarseStepSeconds > 0, 'gestures.coarseStepSeconds must be > 0');
  assert(cfg.gestures.fineStepSeconds > 0, 'gestures.fineStepSeconds must be > 0');
  assert(cfg.gestures.maxSeconds > 0, 'gestures.maxSeconds must be > 0');
  assert(cfg.behavior.reassertEveryMs >= 0, 'behavior.reassertEveryMs must be >= 0 (0 disables it)');
  assert(cfg.behavior.maxEventsPerMessage >= 0, 'behavior.maxEventsPerMessage must be >= 0 (0 disables the guard)');
  const { ramp } = cfg.gestures;
  assert(ramp.fastGapMs > 0 && ramp.mediumGapMs > ramp.fastGapMs, 'gestures.ramp.mediumGapMs must be > fastGapMs > 0');
  assert(ramp.fastMultiplier >= 1 && ramp.mediumMultiplier >= 1, 'gestures.ramp multipliers must be >= 1');
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
