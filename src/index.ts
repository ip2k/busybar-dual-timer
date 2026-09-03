import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BusyBarClient, InputStream } from './api.ts';
import { monotonicMs } from './clock.ts';
import { generateChime } from './chime.ts';
import { loadConfig, PROJECT_ROOT, type Config } from './config.ts';
import { GestureRecognizer, type Gesture } from './gestures.ts';
import { buildPayload, signature, formatDuration } from './render.ts';
import { DualTimer } from './timers.ts';
import type { InputEvent } from './proto.ts';

const TICK_MS = 200;

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
  private soundSource: { path?: string; stock_path?: string } | null = null;
  private soundsPlayed = 0;
  private lastSoundAt = 0;
  private drawing = false;
  private lastDrawAt = 0;
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
    if (sound.mode === 'none') return;
    if (sound.mode === 'stock') {
      this.soundSource = { stock_path: sound.stockPath! };
      return;
    }

    const localPath = resolve(PROJECT_ROOT, 'assets', sound.file);
    const data = existsSync(localPath) ? new Uint8Array(readFileSync(localPath)) : generateChime();
    if (!existsSync(localPath)) log(`[sound] ${localPath} not found, using the built-in synthesised chime`);

    try {
      await this.client.uploadAsset(this.config.app.name, sound.file, data);
      this.soundSource = { path: sound.file };
      log(`[sound] uploaded ${sound.file} (${data.byteLength} bytes) to app '${this.config.app.name}'`);
    } catch (error) {
      log('[sound] upload failed, continuing without audio:', (error as Error).message);
    }
  }

  private onInput(event: InputEvent, atMs: number): void {
    if (event.kind === 'button') {
      this.gestures.handle(event.button, event.action, atMs);
      return;
    }
    if (event.kind === 'encoder') {
      this.gestures.handleEncoder(event.delta);
      return;
    }
    if (event.kind === 'switch') {
      // Position changes mean a different system app took the screen; our next
      // draw re-asserts the widget at its configured priority.
      log(`[input] switch -> ${event.position}`);
      this.lastSignature = '';
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
      if (
        this.soundSource &&
        this.soundsPlayed < sound.repeat &&
        monotonicMs() - this.lastSoundAt >= sound.repeatEveryMs
      ) {
        this.lastSoundAt = monotonicMs();
        this.soundsPlayed += 1;
        this.client.playAudio(this.config.app.name, this.soundSource).catch((error) => {
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
      const period = 1000 / Math.max(1, this.config.expiry.flashHz);
      return Math.floor(monotonicMs() / (period / 2)) % 2 === 0;
    }
    return Math.floor(monotonicMs() / 500) % 2 === 0;
  }

  private async render(force = false): Promise<void> {
    if (this.drawing) return;
    const payload = buildPayload(
      { snapshot: this.timer.snapshot(), blinkOn: this.blinkOn() },
      {
        applicationName: this.config.app.name,
        priority: this.config.app.priority,
        ledColor: this.config.expiry.ledColor,
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
