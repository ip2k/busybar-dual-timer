import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ButtonName = 'ok' | 'back' | 'start';
export type TapMode = 'deferred' | 'immediate';
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
    button: ButtonName;
    longPressMs: number;
    multiTapWindowMs: number;
    tapMode: TapMode;
    resetTapCount: number;
  };
  behavior: {
    resetOnSwitch: boolean;
    autoAdvanceOnExpiry: boolean;
    streamFrames: boolean;
    startPaused: boolean;
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
    button: 'start',
    longPressMs: 700,
    multiTapWindowMs: 400,
    tapMode: 'deferred',
    resetTapCount: 3,
  },
  behavior: {
    resetOnSwitch: false,
    autoAdvanceOnExpiry: false,
    streamFrames: true,
    startPaused: true,
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
  assert(['ok', 'back', 'start'].includes(cfg.gestures.button), "gestures.button must be 'ok', 'back' or 'start'");
  assert(['deferred', 'immediate'].includes(cfg.gestures.tapMode), "gestures.tapMode must be 'deferred' or 'immediate'");
  assert(cfg.gestures.longPressMs > 100, 'gestures.longPressMs must be > 100');
  assert(cfg.gestures.multiTapWindowMs > 50, 'gestures.multiTapWindowMs must be > 50');
  assert(cfg.gestures.resetTapCount >= 2, 'gestures.resetTapCount must be >= 2');
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
