import type { ButtonAction, ButtonName } from './proto.ts';

export type Gesture =
  | { kind: 'toggle' }
  | { kind: 'reset' }
  | { kind: 'switch' }
  | { kind: 'adjust'; deltaMs: number };

export interface RampOptions {
  fastGapMs: number;
  fastMultiplier: number;
  mediumGapMs: number;
  mediumMultiplier: number;
}

export interface GestureOptions {
  toggleButton: ButtonName;
  resetButton: ButtonName;
  /** Pressing the dial in. On this hardware that arrives as the `ok` button. */
  switchButton: ButtonName;
  coarseStepSeconds: number;
  fineStepSeconds: number;
  ramp: RampOptions;
}

/**
 * Maps the Bar's physical controls onto timer actions.
 *
 *   START            start / pause
 *   BACK             reset
 *   dial click       switch A <-> B
 *   dial spin        adjust by `coarseStepSeconds`
 *   click + spin     adjust by `fineStepSeconds`
 *
 * Every action fires on the press itself. Because no control is overloaded with
 * a multi-tap, there is nothing to disambiguate and therefore no window to wait
 * out — start/pause is instant. The previous mapping put start, switch and reset
 * all on START, which cost `multiTapWindowMs` of latency on every tap.
 *
 * The one ambiguity left is the dial: a click means "switch", but a click is
 * also how you hold it to get fine steps. So the switch is emitted on *release*
 * and suppressed if the dial turned while it was down — the same
 * swallow-the-release trick the old long-press used.
 *
 * Spinning fast multiplies the step (see `RampOptions`); a detent can arrive as
 * little as 15 ms after the last one, so without ramping a long adjustment is a
 * lot of wrist.
 */
export class GestureRecognizer {
  private switchDown = false;
  private spunWhileDown = false;
  private lastDetentAt = 0;

  private readonly options: GestureOptions;
  private readonly emit: (gesture: Gesture) => void;

  constructor(options: GestureOptions, emit: (gesture: Gesture) => void) {
    this.options = options;
    this.emit = emit;
  }

  handle(button: ButtonName, action: ButtonAction): void {
    const { toggleButton, resetButton, switchButton } = this.options;

    if (action === 'press') {
      if (button === toggleButton) this.emit({ kind: 'toggle' });
      else if (button === resetButton) this.emit({ kind: 'reset' });
      else if (button === switchButton) {
        this.switchDown = true;
        this.spunWhileDown = false;
      }
      return;
    }

    if (button === switchButton && this.switchDown) {
      this.switchDown = false;
      // A turn while held meant "fine adjust", not "switch".
      if (!this.spunWhileDown) this.emit({ kind: 'switch' });
      this.spunWhileDown = false;
    }
  }

  /**
   * One detent of the dial. `delta` is +/-1.
   *
   * `atMs` should be the device's own clock for the message that carried this
   * event. Ramping keys off the interval between detents, and on a laggy or
   * spotty network local arrival time is a property of the *network*, not of
   * how fast the dial was turned: a stall that releases three buffered detents
   * at once would look like a very fast spin and ramp to the largest multiplier,
   * jumping the timer by a wild amount. The device clock is immune to that.
   *
   * Falls back to local time when the device sends no timestamp, and refuses to
   * ramp on a gap that went backwards (clock step, or events out of order).
   */
  handleEncoder(delta: number, atMs = 0): void {
    if (delta === 0) return;
    const now = atMs > 0 ? atMs : Date.now();
    const gap = now >= this.lastDetentAt ? now - this.lastDetentAt : Number.POSITIVE_INFINITY;
    this.lastDetentAt = now;

    if (this.switchDown) this.spunWhileDown = true;

    const { ramp, coarseStepSeconds, fineStepSeconds } = this.options;
    const multiplier =
      gap < ramp.fastGapMs
        ? ramp.fastMultiplier
        : gap < ramp.mediumGapMs
          ? ramp.mediumMultiplier
          : 1;

    const stepSeconds = this.switchDown ? fineStepSeconds : coarseStepSeconds;
    this.emit({ kind: 'adjust', deltaMs: delta * stepSeconds * multiplier * 1000 });
  }

  dispose(): void {
    this.switchDown = false;
    this.spunWhileDown = false;
  }
}
