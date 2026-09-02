import { monotonicMs } from './clock.ts';
import type { TimerConfig } from './config.ts';

export type Phase = 'idle' | 'running' | 'paused' | 'expired';

interface Slot {
  config: TimerConfig;
  /**
   * The timer's length. Starts from `config.seconds` but is owned by the slot,
   * not the config, because the dial can change it at runtime.
   */
  totalMs: number;
  remainingMs: number;
  /** Monotonic ms when the current run started; null while not running. */
  startedAt: number | null;
}

export interface Snapshot {
  index: number;
  label: string;
  color: string;
  phase: Phase;
  remainingMs: number;
  totalMs: number;
  fraction: number;
}

/**
 * Two independent countdowns, only one of which is ever active. Switching
 * banks the active timer's remaining time so you can flip back and forth
 * without losing progress.
 */
export class DualTimer {
  private slots: [Slot, Slot];
  private active = 0;
  private phase: Phase = 'idle';

  constructor(configs: [TimerConfig, TimerConfig]) {
    this.slots = [
      { config: configs[0], totalMs: configs[0].seconds * 1000, remainingMs: configs[0].seconds * 1000, startedAt: null },
      { config: configs[1], totalMs: configs[1].seconds * 1000, remainingMs: configs[1].seconds * 1000, startedAt: null },
    ];
  }

  private get slot(): Slot {
    return this.slots[this.active]!;
  }

  private settle(): void {
    const slot = this.slot;
    if (slot.startedAt === null) return;
    const elapsed = monotonicMs() - slot.startedAt;
    slot.remainingMs = Math.max(0, slot.remainingMs - elapsed);
    slot.startedAt = null;
  }

  /** Remaining time on the active timer right now. */
  remainingMs(): number {
    const slot = this.slot;
    if (slot.startedAt === null) return slot.remainingMs;
    return Math.max(0, slot.remainingMs - (monotonicMs() - slot.startedAt));
  }

  snapshot(): Snapshot {
    const slot = this.slot;
    const totalMs = slot.totalMs;
    const remainingMs = this.remainingMs();
    return {
      index: this.active,
      label: slot.config.label,
      color: slot.config.color,
      phase: this.phase,
      remainingMs,
      totalMs,
      fraction: totalMs === 0 ? 0 : remainingMs / totalMs,
    };
  }

  /** Start/pause. Starting an expired or zeroed timer restarts it from the top. */
  toggle(): void {
    if (this.phase === 'running') {
      this.settle();
      this.phase = 'paused';
      return;
    }
    const slot = this.slot;
    if (this.phase === 'expired' || slot.remainingMs <= 0) {
      slot.remainingMs = slot.totalMs;
    }
    slot.startedAt = monotonicMs();
    this.phase = 'running';
  }

  pause(): void {
    if (this.phase !== 'running') return;
    this.settle();
    this.phase = 'paused';
  }

  /**
   * Flip A <-> B. The timer you leave is always banked at its current
   * remaining time, unless `resetOutgoing` is set, in which case it goes back
   * to full.
   */
  switchTimer(resetOutgoing = false): void {
    this.settle();
    if (resetOutgoing) this.slot.remainingMs = this.slot.totalMs;
    this.active = this.active === 0 ? 1 : 0;
    const next = this.slot;
    const full = next.totalMs;
    if (next.remainingMs <= 0) next.remainingMs = full;
    this.phase = next.remainingMs === full ? 'idle' : 'paused';
  }

  /** Reset the active timer to its full length and stop it. */
  reset(both = false): void {
    this.settle();
    const targets = both ? this.slots : [this.slot];
    for (const slot of targets) {
      slot.startedAt = null;
      slot.remainingMs = slot.totalMs;
    }
    this.phase = 'idle';
  }

  /**
   * Nudge the active timer's length by `deltaMs`, clamped to [0, maxMs].
   *
   * While idle or paused this moves the timer's length and its remaining time
   * together — you are setting the timer. While running it extends or shortens
   * the countdown in progress, raising the length to match if you push past it
   * so the progress fraction never exceeds 1. Returns the new remaining time.
   */
  adjust(deltaMs: number, maxMs = 24 * 60 * 60 * 1000): number {
    const wasRunning = this.phase === 'running';
    this.settle();
    const slot = this.slot;
    const next = Math.min(maxMs, Math.max(0, slot.remainingMs + deltaMs));
    slot.remainingMs = next;

    if (wasRunning) {
      if (next > slot.totalMs) slot.totalMs = next;
      slot.startedAt = monotonicMs();
    } else {
      slot.totalMs = next;
      this.phase = next > 0 ? 'paused' : 'idle';
    }
    return next;
  }

  /** Call on every tick; returns true exactly once, on the transition to zero. */
  checkExpiry(): boolean {
    if (this.phase !== 'running') return false;
    if (this.remainingMs() > 0) return false;
    this.settle();
    this.slot.remainingMs = 0;
    this.phase = 'expired';
    return true;
  }

  acknowledgeExpiry(): void {
    if (this.phase === 'expired') this.phase = 'idle';
  }

  get currentPhase(): Phase {
    return this.phase;
  }
}
