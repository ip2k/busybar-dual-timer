import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { BusyBarClient, InputStream } from './api.ts';
import { loadAudioForDevice } from './audio-file.ts';
import { monotonicMs } from './clock.ts';
import { generateChime, tonesForSlot } from './chime.ts';
import { loadConfig, PROJECT_ROOT, type Config, type ToneConfig } from './config.ts';
import { GestureRecognizer, type Gesture } from './gestures.ts';
import { buildPayload, signature, formatDuration } from './render.ts';
import { DualTimer } from './timers.ts';
import type { InputEvent } from './proto.ts';

const TICK_MS = 200;

/** `chime.wav` -> `chime-2.wav`, keeping the extension the device expects. */
function prefixed(file: string, index: number): string {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? `${file.slice(0, dot)}-${index + 1}${file.slice(dot)}` : `${file}-${index + 1}`;
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

class DualTimerApp {
  private readonly client: BusyBarClient;
  private readonly timer: DualTimer;
  private readonly gestures: GestureRecognizer;
  private readonly stream: InputStream;

  private lastSignature = '';
  private lastElementIds = '';
  private expiryStartedAt: number | null = null;
  /** One sound per timer slot, so A and B are audibly different. */
  private soundSources: ({ path?: string; stock_path?: string } | null)[] = [];
  private soundsPlayed = 0;
  private lastSoundAt = 0;
  private drawing = false;
  private lastDrawAt = 0;
  /** Last lever position seen. Null until it moves — no endpoint reports it. */
  private switchPosition: string | null = null;
  private cleared = false;
  private ticker: NodeJS.Timeout | null = null;

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = new BusyBarClient(config.device.host, config.device.apiToken);
    this.timer = new DualTimer(config.timers);
    this.gestures = new GestureRecognizer(config.gestures, (gesture) => this.onGesture(gesture));
    this.stream = new InputStream(config.device.host, {
      onInput: (event, atMs) => this.onInput(event, atMs),
      onOpen: () => log('[stream] connected'),
      onClose: (reason) => log(`[stream] disconnected (${reason}), reconnecting`),
    }, {
      apiToken: config.device.apiToken,
      enableFrames: config.behavior.streamFrames,
      maxEventsPerMessage: config.behavior.maxEventsPerMessage,
    });
  }

  async start(): Promise<void> {
    const version = await this.client.version();
    log(`[bar] ${this.config.device.host} firmware API ${version.api_semver ?? 'unknown'}`);

    await this.prepareSound();

    if (!this.config.behavior.startPaused) this.timer.toggle();

    const gate = this.config.behavior.activeSwitchPosition;
    if (gate !== null) {
      log(`[display] waiting for the lever — the widget shows only on '${gate}'`);
      log('[display] the position is only reported when it changes, so flip the lever to begin');
    }

    this.stream.start();
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    await this.render(true);

    const [a, b] = this.config.timers;
    const g = this.config.gestures;
    log(
      `[ready] ${a.label}=${formatDuration(a.seconds * 1000)} ${b.label}=${formatDuration(b.seconds * 1000)} — ` +
        `${g.toggleButton} start/pause · dial click switches · dial double-click resets · ` +
        `dial turn ±${g.coarseStepSeconds}s · hold+turn ±${g.fineStepSeconds}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.gestures.dispose();
    this.stream.stop();
    try {
      await this.client.clear(this.config.app.name);
    } catch (error) {
      log('[shutdown] could not clear display:', (error as Error).message);
    }
  }

  private async prepareSound(): Promise<void> {
    const { sound } = this.config.expiry;
    this.soundSources = this.config.timers.map(() => null);
    if (sound.mode === 'none') return;
    if (sound.mode === 'stock') {
      this.soundSources = this.config.timers.map(() => ({ stock_path: sound.stockPath! }));
      return;
    }

    // One asset per timer. Each gets its own filename so uploading B's chime
    // cannot overwrite A's on the device.
    for (const [index, timer] of this.config.timers.entries()) {
      const file = timer.sound?.file ?? (index === 0 ? sound.file : prefixed(sound.file, index));
      const data = this.soundDataFor(index, timer.sound?.file, timer.sound?.tones);
      try {
        await this.client.uploadAsset(this.config.app.name, file, data);
        this.soundSources[index] = { path: file };
        log(`[sound] ${timer.label}: uploaded ${file} (${data.byteLength} bytes)`);
      } catch (error) {
        log(`[sound] ${timer.label}: upload failed, continuing without audio:`, (error as Error).message);
      }
    }
  }

  /** Resolve one timer's audio: its own file, its own tones, or the slot default. */
  private soundDataFor(index: number, file: string | undefined, tones: ToneConfig[] | undefined): Uint8Array {
    const name = file ?? (index === 0 ? this.config.expiry.sound.file : undefined);
    if (name) {
      const localPath = resolve(PROJECT_ROOT, 'assets', name);
      if (existsSync(localPath)) {
        try {
          // Drop in any ordinary sound file; the device only plays headerless
          // PCM, so convert rather than making people work that out themselves.
          const converted = loadAudioForDevice(localPath);
          log(`[sound] ${name}: ${converted.note}`);
          if (converted.info) {
            const { sampleRate, channels, bitDepth, duration } = converted.info;
            log(`[sound] source was ${sampleRate}Hz ${channels}ch ${bitDepth}-bit, ${duration.toFixed(2)}s`);
          }
          return converted.pcm;
        } catch (error) {
          log(`[sound] could not read ${name}: ${(error as Error).message}`);
          log('[sound] falling back to a synthesised chime');
        }
      }
    }
    return generateChime(tones ?? tonesForSlot(index));
  }

  /**
   * Should the widget be on screen right now?
   *
   * With `activeSwitchPosition` set, the lever chooses between the device's own
   * apps and this timer. The position is only reported when it changes, so
   * until we have seen it we stay hidden rather than covering whatever the
   * device is showing — hiding is the recoverable mistake.
   */
  private get onScreen(): boolean {
    const wanted = this.config.behavior.activeSwitchPosition;
    if (wanted === null) return true;
    return this.switchPosition === wanted;
  }

  private onInput(event: InputEvent, atMs: number): void {
    // Switch events are always processed — they are how we learn the lever moved.
    if (event.kind !== 'switch' && !this.onScreen) {
      // When the lever is elsewhere, this app is not running as far as the user
      // is concerned, and its controls must be inert. Acting on presses here
      // would quietly mutate timer state behind the device's own UI, and worse,
      // would make the buttons feel broken while someone is using another app.
      return;
    }

    if (event.kind === 'button') {
      this.gestures.handle(event.button, event.action, atMs);
      return;
    }
    if (event.kind === 'encoder') {
      this.gestures.handleEncoder(event.delta);
      return;
    }
    if (event.kind === 'switch') {
      const was = this.onScreen;
      this.switchPosition = event.position;
      const now = this.onScreen;
      log(`[input] switch -> ${event.position}${was !== now ? (now ? ' (widget on)' : ' (widget off)') : ''}`);
      // A position change also means a different system app may have taken the
      // screen, so force the next draw rather than trusting the cached signature.
      this.lastSignature = '';
      if (was && !now) {
        this.gestures.dispose(); // drop any half-finished press
        void this.hide();
      }
    }
  }

  private onGesture(gesture: Gesture): void {
    if (this.timer.currentPhase === 'expired') {
      this.dismissExpiry();
      if (gesture.kind === 'toggle') return; // that press only silenced the alarm
    }

    switch (gesture.kind) {
      case 'toggle':
        this.timer.toggle();
        log(`[gesture] start -> ${this.timer.currentPhase}`);
        break;
      case 'switch': {
        this.timer.switchTimer(this.config.behavior.resetOnSwitch);
        const snapshot = this.timer.snapshot();
        log(`[gesture] dial click -> timer ${snapshot.label} (${formatDuration(snapshot.remainingMs)})`);
        break;
      }
      case 'reset':
        this.timer.reset();
        log('[gesture] dial double-click -> reset');
        break;
      case 'adjust': {
        const now = this.timer.adjust(gesture.deltaMs, this.config.gestures.maxSeconds * 1000);
        const sign = gesture.deltaMs >= 0 ? '+' : '-';
        log(`[gesture] dial ${sign}${formatDuration(Math.abs(gesture.deltaMs))} -> ${formatDuration(now)}`);
        // Deliberately no immediate render: a fast spin emits detents ~15 ms
        // apart and the tick redraws at TICK_MS anyway, which rate-limits us.
        return;
      }
    }
    void this.render();
  }

  private dismissExpiry(): void {
    this.timer.acknowledgeExpiry();
    this.expiryStartedAt = null;
    this.soundsPlayed = 0;
  }

  private async tick(): Promise<void> {
    if (this.timer.checkExpiry()) this.onExpired();

    if (this.timer.currentPhase === 'expired' && this.expiryStartedAt !== null) {
      const elapsed = monotonicMs() - this.expiryStartedAt;
      const { sound } = this.config.expiry;
      // The sound belongs to whichever timer expired, so A and B are
      // distinguishable from the next room without looking.
      const source = this.soundSources[this.timer.snapshot().index] ?? null;
      if (
        source &&
        this.soundsPlayed < sound.repeat &&
        monotonicMs() - this.lastSoundAt >= sound.repeatEveryMs
      ) {
        this.lastSoundAt = monotonicMs();
        this.soundsPlayed += 1;
        this.client.playAudio(this.config.app.name, source).catch((error) => {
          log('[sound] playback failed:', (error as Error).message);
        });
      }
      if (elapsed >= this.config.expiry.flashSeconds * 1000) {
        this.dismissExpiry();
        if (this.config.behavior.autoAdvanceOnExpiry) {
          this.timer.switchTimer(false);
          this.timer.toggle();
          log('[expiry] auto-advanced to the other timer');
        }
      }
    }

    await this.render();
  }

  private onExpired(): void {
    const snapshot = this.timer.snapshot();
    log(`[expiry] timer ${snapshot.label} finished`);
    this.expiryStartedAt = monotonicMs();
    this.soundsPlayed = 0;
    this.lastSoundAt = 0;
  }

  private blinkOn(): boolean {
    const phase = this.timer.currentPhase;
    if (phase === 'expired') {
      // flashHz 0 means hold "DONE" steady rather than strobing. That is the
      // default: a finished timer wants to be readable, and a 72x16 panel
      // blinking at 3Hz across the desk is more irritating than informative.
      if (this.config.expiry.flashHz <= 0) return true;
      const period = 1000 / this.config.expiry.flashHz;
      return Math.floor(monotonicMs() / (period / 2)) % 2 === 0;
    }
    return Math.floor(monotonicMs() / 500) % 2 === 0;
  }

  /** Take our drawing down so the device's own app is visible again. */
  private async hide(): Promise<void> {
    if (this.cleared) return;
    this.cleared = true;
    this.lastSignature = '';
    this.lastElementIds = '';
    try {
      await this.client.clear(this.config.app.name);
      log('[display] handed the screen back to the device');
    } catch (error) {
      log('[display] could not clear:', (error as Error).message);
    }
  }

  private async render(force = false): Promise<void> {
    if (!this.onScreen) {
      await this.hide();
      return;
    }
    if (this.cleared) {
      this.cleared = false;
      force = true;
    }
    if (this.drawing) return;
    const payload = buildPayload(
      { snapshot: this.timer.snapshot(), blinkOn: this.blinkOn() },
      {
        applicationName: this.config.app.name,
        priority: this.config.app.priority,
        ledColor: this.config.expiry.ledColor,
        ledWhileRunning: this.config.behavior.ledWhileRunning,
      },
    );
    const sig = signature(payload);
    // The firmware owns the buttons and will navigate on its own — BACK exits to
    // the device UI, and the widget is simply gone. Nothing tells us that
    // happened, and a paused timer's signature never changes, so without a
    // periodic re-assert the widget would stay off screen indefinitely.
    // Redrawing at priority 95 reclaims it.
    const stale = monotonicMs() - this.lastDrawAt >= this.config.behavior.reassertEveryMs;
    if (!force && !stale && sig === this.lastSignature) return;

    // Element sets are keyed by id; when the set itself changes (bar appears,
    // flash rectangle comes and goes) stale elements have to be cleared first.
    const elementIds = payload.elements.map((element) => element.id).join(',');
    const needsClear = elementIds !== this.lastElementIds;

    this.drawing = true;
    try {
      if (needsClear) await this.client.clear(this.config.app.name);
      await this.client.draw(payload);
      this.lastDrawAt = monotonicMs();
      this.lastSignature = sig;
      this.lastElementIds = elementIds;
    } catch (error) {
      this.lastSignature = '';
      log('[draw] failed:', (error as Error).message);
    } finally {
      this.drawing = false;
    }
  }
}

const config = loadConfig(process.argv[2]);
const app = new DualTimerApp(config);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log(`[shutdown] ${signal}`);
    void app.stop().then(() => process.exit(0));
  });
}

try {
  await app.start();
} catch (error) {
  console.error('[fatal]', (error as Error).message);
  process.exit(1);
}
