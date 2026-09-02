import type { ButtonAction, ButtonName } from './proto.ts';
import type { TapMode } from './config.ts';

export type Gesture =
  | { kind: 'tap'; count: number }
  | { kind: 'longPress' }
  | { kind: 'reset' };

export interface GestureOptions {
  button: ButtonName;
  longPressMs: number;
  multiTapWindowMs: number;
  tapMode: TapMode;
  resetTapCount: number;
}

/**
 * Turns raw press/release pairs into tap / long-press / multi-tap gestures.
 *
 * A long press fires the moment the threshold is crossed while the button is
 * still down, so the Bar reacts under your thumb rather than on release; the
 * release that follows is then swallowed.
 *
 * Taps are counted inside a rolling window. In `deferred` mode nothing happens
 * until the window closes, which costs `multiTapWindowMs` of latency but keeps
 * a triple-tap clean. In `immediate` mode each tap acts as it lands: tap 1
 * toggles, tap 2 toggles back, tap 3 resets — same end state, no latency.
 */
export class GestureRecognizer {
  private pressedAt: number | null = null;
  private longPressTimer: NodeJS.Timeout | null = null;
  private longPressFired = false;
  private tapCount = 0;
  private tapTimer: NodeJS.Timeout | null = null;

  private readonly options: GestureOptions;
  private readonly emit: (gesture: Gesture) => void;

  constructor(options: GestureOptions, emit: (gesture: Gesture) => void) {
    this.options = options;
    this.emit = emit;
  }

  handle(button: ButtonName, action: ButtonAction): void {
    if (button !== this.options.button) return;
    if (action === 'press') this.onPress();
    else this.onRelease();
  }

  dispose(): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.longPressTimer = null;
    this.tapTimer = null;
  }

  private onPress(): void {
    if (this.pressedAt !== null) return; // duplicate press, ignore
    this.pressedAt = Date.now();
    this.longPressFired = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressFired = true;
      this.longPressTimer = null;
      this.flushTaps(); // a hold ends any tap run in progress
      this.emit({ kind: 'longPress' });
    }, this.options.longPressMs);
  }

  private onRelease(): void {
    if (this.pressedAt === null) return;
    this.pressedAt = null;
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }
    this.registerTap();
  }

  private registerTap(): void {
    this.tapCount += 1;

    if (this.options.tapMode === 'immediate') {
      const count = this.tapCount;
      this.emit(count >= this.options.resetTapCount ? { kind: 'reset' } : { kind: 'tap', count });
      if (count >= this.options.resetTapCount) {
        this.tapCount = 0;
        if (this.tapTimer) clearTimeout(this.tapTimer);
        this.tapTimer = null;
        return;
      }
    }

    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null;
      const count = this.tapCount;
      this.tapCount = 0;
      if (this.options.tapMode === 'deferred' && count > 0) {
        this.emit(count >= this.options.resetTapCount ? { kind: 'reset' } : { kind: 'tap', count });
      }
    }, this.options.multiTapWindowMs);
  }

  private flushTaps(): void {
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.tapCount = 0;
  }
}
