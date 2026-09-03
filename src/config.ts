import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SWITCH_POSITIONS, type SwitchPosition } from './proto.ts';
import { MAX_SOUND_SECONDS } from './audio.ts';
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
  display: {
    /**
     * Display brightness while this runs.
     *
     * `"auto"` (the default) hands it to the Bar's ambient light sensor, so the
     * panel is readable in a bright room and not blinding in a dark one. A
     * number 0-100 pins it; `null` leaves the device's own setting alone.
     *
     * Brightness is device-wide rather than per-app. Whatever was set before is
     * read at startup and restored on a clean shutdown — but a hard kill skips
     * that, so `null` is the choice if the app must never touch it at all.
     */
    brightness: 'auto' | number | null;
  };
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
     * - `transitions` (default) fire it once when something happens — started,
     *               switched, expired — so you get three clean blinks and then
     *               quiet. This is what a "notification" preset is for.
     * - `running`   re-fire it on every redraw while a timer runs, which reads
     *               as continuous flashing in that timer's colour. Use it if you
     *               want an ambient "which timer is going" light; it is a
     *               workaround for the missing steady-on state, and it flickers
     *               in peripheral vision all session.
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
    /**
     * How long "DONE" stays on screen after the alarm ends.
     *
     * A finished timer should not quietly revert to `00:00` — that looks
     * identical to one that was never started. But holding the panel forever is
     * worse: the Bar stops being usable for anything else until someone presses
     * a button, which is antisocial for a device that has its own apps.
     *
     * Seconds to hold, then release the screen. `null` holds until acknowledged.
     * Pressing anything dismisses it immediately either way.
     */
    holdSeconds: number | null;
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
  display: { brightness: 'auto' },
  timers: [
    // #2B7FFF is BUSY's own brand blue, from the firmware's web UI.
    { label: 'A', seconds: 1500, color: '#2B7FFFFF' },
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
    ledMode: 'transitions',
    activeSwitchPosition: null,
  },
  expiry: {
    flashSeconds: 10,
    holdSeconds: 300,
    // The alarm inverts the whole panel at this rate — solid colour with the
    // text knocked out, alternating with text on black. 0 holds it steady.
    //
    // 2.5 Hz is not arbitrary: the half-period is 200 ms, exactly one render
    // tick, so the panel flips once per tick and the flash is even. Rates whose
    // half-period is not a multiple of the tick beat against it and stutter —
    // 2 Hz needs 250 ms and visibly drops and doubles frames. Sensible even
    // choices are 2.5, 1.25 and 0.833 Hz.
    flashHz: 2.5,
    ledColor: '#E60022FF', // BUSY's brand error red
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
    // JSON.parse happily creates an own "__proto__" property, and assigning it
    // back would swap the merged object's prototype. Nothing legitimate in a
    // config file has these names.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? merge(current, value) : value;
  }
  return out as T;
}

const HEX_RGBA = /^#[0-9a-fA-F]{8}$/;
/** Letters, digits, dot, dash, underscore; no leading dot or dash; at most 128 characters. */
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `host` or `host:port`. An IPv6 literal must be bracketed. */
const HOST = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(:\d{1,5})?$/;
/** Also becomes a directory name on the device (`/ext/user_assets/<name>/`). */
const APP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Printable ASCII. The HTTP client refuses anything else, with a far less helpful message. */
const TOKEN = /^[\x20-\x7e]+$/;
const LABEL = /^[\x20-\x7e]{1,16}$/;

/** Longest a timer can be set to, from config or the dial: 99:59:59. */
export const MAX_TIMER_SECONDS = 359_999;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`config: ${message}`);
}

const show = (value: unknown): string => JSON.stringify(value) ?? String(value);

/**
 * A finite number within [min, max]. Strings are refused outright: `"60" > 0`
 * is true in JS, which is how a typo used to become behaviour.
 */
function num(value: unknown, key: string, min: number, max: number, integer = false): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value), `${key} must be a number (got ${show(value)})`);
  assert(!integer || Number.isInteger(value), `${key} must be a whole number (got ${show(value)})`);
  assert(value >= min && value <= max, `${key} must be between ${min} and ${max} (got ${show(value)})`);
}

function bool(value: unknown, key: string): asserts value is boolean {
  assert(typeof value === 'boolean', `${key} must be true or false (got ${show(value)})`);
}

function str(value: unknown, key: string, pattern: RegExp, what: string): asserts value is string {
  assert(typeof value === 'string' && pattern.test(value), `${key} must be ${what} (got ${show(value)})`);
}

function oneOf<T extends string>(value: unknown, key: string, options: readonly T[]): asserts value is T {
  assert(
    typeof value === 'string' && (options as readonly string[]).includes(value),
    `${key} must be one of ${options.map((option) => `'${option}'`).join(', ')} (got ${show(value)})`,
  );
}

/**
 * Asset filenames must be plain names, not paths.
 *
 * `expiry.sound.file` and `timers[].sound.file` are joined onto an assets
 * directory and the result is read and uploaded to the device. Left unchecked,
 * `../../../../etc/passwd` — or any absolute path — escapes that directory and
 * the file's contents leave the machine. The name also ends up in a shell
 * command printed for the user to copy when ffmpeg is missing, so quotes, `$`
 * and the like are refused too. Nobody needs any of that in a filename.
 */
function assertBareFilename(value: unknown, key: string): asserts value is string {
  assert(typeof value === 'string' && value.length > 0, `${key} must not be empty`);
  assert(
    !value.includes('/') && !value.includes('\\'),
    `${key} must be a bare filename, not a path (got ${show(value)})`,
  );
  str(
    value,
    key,
    FILENAME,
    'a plain filename: letters, digits, dot, dash or underscore, not starting with a dot or dash, at most 128 characters',
  );
}

function validateTones(tones: unknown, key: string): asserts tones is ToneConfig[] {
  assert(Array.isArray(tones) && tones.length > 0 && tones.length <= 32, `${key} must be a non-empty array of at most 32 tones`);
  let totalMs = 0;
  for (const [j, tone] of tones.entries()) {
    assert(isPlainObject(tone), `${key}[${j}] must be an object`);
    num(tone.freq, `${key}[${j}].freq`, 20, 20_000);
    num(tone.ms, `${key}[${j}].ms`, 1, MAX_SOUND_SECONDS * 1000);
    if (tone.gain !== undefined) num(tone.gain, `${key}[${j}].gain`, 0, 1);
    totalMs += tone.ms;
  }
  assert(totalMs <= MAX_SOUND_SECONDS * 1000, `${key} must add up to at most ${MAX_SOUND_SECONDS} seconds`);
}

/**
 * Every value is checked for type as well as range. A config file is trusted
 * input, but "trusted" is not "unchecked": a string where a number belongs
 * used to pass silently, and some of these values are sent to the device or
 * turned into memory allocations.
 */
function validate(cfg: Config): void {
  str(
    cfg.device.host,
    'device.host',
    HOST,
    "a hostname or address, optionally with :port, like '10.0.4.20' or 'busy.local:80'",
  );
  if (cfg.device.apiToken !== null) {
    str(cfg.device.apiToken, 'device.apiToken', TOKEN, 'null or a non-empty string of printable characters');
  }
  str(cfg.app.name, 'app.name', APP_NAME, 'letters, digits, dash or underscore, at most 64 characters');
  // System apps sit at 10, an active BUSY session at 90.
  num(cfg.app.priority, 'app.priority', 1, 100, true);

  const brightness = cfg.display.brightness;
  assert(
    brightness === null ||
      brightness === 'auto' ||
      (typeof brightness === 'number' && Number.isInteger(brightness) && brightness >= 0 && brightness <= 100),
    "display.brightness must be null, 'auto', or an integer 0-100",
  );

  assert(Array.isArray(cfg.timers) && cfg.timers.length === 2, 'timers must contain exactly two entries');
  for (const [i, timer] of cfg.timers.entries()) {
    assert(isPlainObject(timer), `timers[${i}] must be an object`);
    str(timer.label, `timers[${i}].label`, LABEL, '1-16 printable characters');
    num(timer.seconds, `timers[${i}].seconds`, 1, MAX_TIMER_SECONDS);
    str(timer.color, `timers[${i}].color`, HEX_RGBA, '#RRGGBBAA');
    if (timer.ledColor !== undefined) str(timer.ledColor, `timers[${i}].ledColor`, HEX_RGBA, '#RRGGBBAA');
    if (timer.sound !== undefined) {
      assert(isPlainObject(timer.sound), `timers[${i}].sound must be an object`);
      if (timer.sound.file !== undefined) assertBareFilename(timer.sound.file, `timers[${i}].sound.file`);
      if (timer.sound.tones !== undefined) validateTones(timer.sound.tones, `timers[${i}].sound.tones`);
    }
  }

  const buttons = ['ok', 'back', 'start'] as const;
  oneOf(cfg.gestures.toggleButton, 'gestures.toggleButton', buttons);
  oneOf(cfg.gestures.switchButton, 'gestures.switchButton', buttons);
  if (cfg.gestures.resetButton !== null) oneOf(cfg.gestures.resetButton, 'gestures.resetButton', buttons);
  const assigned = [cfg.gestures.toggleButton, cfg.gestures.switchButton, cfg.gestures.resetButton].filter(
    (button): button is ButtonName => button !== null,
  );
  assert(
    new Set(assigned).size === assigned.length,
    'gestures.toggleButton, switchButton and resetButton must all be different buttons',
  );
  num(cfg.gestures.doubleTapMs, 'gestures.doubleTapMs', 51, 5000);
  num(cfg.gestures.coarseStepSeconds, 'gestures.coarseStepSeconds', 1, 3600);
  num(cfg.gestures.fineStepSeconds, 'gestures.fineStepSeconds', 1, 3600);
  num(cfg.gestures.maxSeconds, 'gestures.maxSeconds', 1, MAX_TIMER_SECONDS);

  bool(cfg.behavior.resetOnSwitch, 'behavior.resetOnSwitch');
  bool(cfg.behavior.autoAdvanceOnExpiry, 'behavior.autoAdvanceOnExpiry');
  bool(cfg.behavior.streamFrames, 'behavior.streamFrames');
  bool(cfg.behavior.startPaused, 'behavior.startPaused');
  num(cfg.behavior.maxEventsPerMessage, 'behavior.maxEventsPerMessage', 0, 10_000, true); // 0 disables the guard
  num(cfg.behavior.reassertEveryMs, 'behavior.reassertEveryMs', 0, 3_600_000); // 0 disables it
  oneOf(cfg.behavior.ledMode, 'behavior.ledMode', ['off', 'transitions', 'running'] as const);
  if (cfg.behavior.activeSwitchPosition !== null) {
    oneOf(cfg.behavior.activeSwitchPosition, 'behavior.activeSwitchPosition', SWITCH_POSITIONS);
  }

  num(cfg.expiry.flashSeconds, 'expiry.flashSeconds', 0, 3600);
  if (cfg.expiry.holdSeconds !== null) num(cfg.expiry.holdSeconds, 'expiry.holdSeconds', 0, 86_400); // null holds until acknowledged
  num(cfg.expiry.flashHz, 'expiry.flashHz', 0, 50); // 0 holds DONE steady
  str(cfg.expiry.ledColor, 'expiry.ledColor', HEX_RGBA, '#RRGGBBAA');
  oneOf(cfg.expiry.sound.mode, 'expiry.sound.mode', ['asset', 'stock', 'none'] as const);
  assertBareFilename(cfg.expiry.sound.file, 'expiry.sound.file');
  num(cfg.expiry.sound.repeat, 'expiry.sound.repeat', 0, 100, true);
  num(cfg.expiry.sound.repeatEveryMs, 'expiry.sound.repeatEveryMs', 0, 3_600_000);
  if (cfg.expiry.sound.mode === 'stock') {
    assert(!!cfg.expiry.sound.stockPath, "expiry.sound.stockPath is required when sound.mode is 'stock'");
    // Sent verbatim to the device; keep it to the shape the firmware documents
    // rather than letting a config poke at arbitrary device paths.
    str(cfg.expiry.sound.stockPath, 'expiry.sound.stockPath', /^shared\/[a-z0-9_.]+$/, "like 'shared/name.snd'");
  }
}

/**
 * Every key a config may contain. Anything else is almost certainly a typo,
 * and a typo that is silently ignored is a setting that silently does nothing.
 * Add new keys here as well as to `Config` and `DEFAULTS`.
 */
const SHAPE = {
  device: { host: true, apiToken: true },
  app: { name: true, priority: true },
  display: { brightness: true },
  timers: [
    {
      label: true,
      seconds: true,
      color: true,
      ledColor: true,
      sound: { file: true, tones: [{ freq: true, ms: true, gain: true }] },
    },
  ],
  gestures: {
    toggleButton: true,
    switchButton: true,
    resetButton: true,
    doubleTapMs: true,
    coarseStepSeconds: true,
    fineStepSeconds: true,
    maxSeconds: true,
  },
  behavior: {
    resetOnSwitch: true,
    autoAdvanceOnExpiry: true,
    streamFrames: true,
    startPaused: true,
    maxEventsPerMessage: true,
    reassertEveryMs: true,
    ledMode: true,
    activeSwitchPosition: true,
  },
  expiry: {
    flashSeconds: true,
    holdSeconds: true,
    flashHz: true,
    ledColor: true,
    sound: { mode: true, file: true, stockPath: true, repeat: true, repeatEveryMs: true },
  },
};

/** Keys in `value` that `shape` does not know about, as dotted paths. */
export function unknownKeys(value: unknown, shape: unknown = SHAPE, path = ''): string[] {
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, i) => unknownKeys(item, shape[0], `${path}[${i}]`));
  }
  if (!isPlainObject(shape) || !isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(shape, key)) return [here];
    return unknownKeys(child, shape[key], here);
  });
}

export interface LoadedConfig {
  config: Config;
  /** Where the config was read from, or null when built-in defaults were used. */
  configPath: string | null;
  /**
   * Directories to search for assets (custom sounds), most specific first.
   *
   * Assets live next to the *config*, not next to the code. Installed from npm
   * the code sits in `node_modules`, which is no place to keep a file the user
   * edits — it is wiped on upgrade and invisible to them.
   */
  assetDirs: string[];
  /** Keys the file contained that mean nothing here — almost always typos. */
  unknownKeys: string[];
}

/** Where a config may live, in order of precedence. */
export function configSearchPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  // Deduped: running from the project directory makes the first and last the
  // same path, and listing it twice in --help just looks broken.
  return [
    ...new Set([
      resolve(process.cwd(), 'config.json'),
      resolve(xdg, 'busybar-dual-timer', 'config.json'),
      // Alongside the source or an unpacked release tarball.
      resolve(PROJECT_ROOT, 'config.json'),
    ]),
  ];
}

/**
 * Load configuration.
 *
 * An explicit path — `--config` or `BUSY_TIMER_CONFIG` — must exist; asking for
 * a file that is not there is an error rather than something to silently ignore.
 * Otherwise the search paths are tried in turn, and running with none of them is
 * fine: the defaults target the Bar's fixed USB address, so a fresh `npx` run
 * works with no configuration at all.
 */
export function loadConfig(explicitPath?: string): LoadedConfig {
  const requested = explicitPath ?? process.env.BUSY_TIMER_CONFIG;
  let file: string | null = null;

  if (requested) {
    file = resolve(requested);
    if (!existsSync(file)) throw new Error(`config: ${file} does not exist`);
  } else {
    file = configSearchPaths().find((candidate) => existsSync(candidate)) ?? null;
  }

  let raw: unknown = {};
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new Error(`config: could not read ${file}: ${err.message}`);
    }
  }

  if (file) assert(isPlainObject(raw), `${file} must contain a JSON object at the top level`);
  const config = merge(DEFAULTS, raw);
  validate(config);

  const dirs = [file ? dirname(file) : process.cwd(), process.cwd(), PROJECT_ROOT];
  return { config, configPath: file, assetDirs: [...new Set(dirs)], unknownKeys: unknownKeys(raw) };
}

/** The starter config written by `--init`. */
export function exampleConfig(): string {
  return `${JSON.stringify(DEFAULTS, null, 2)}\n`;
}

export { PROJECT_ROOT };
