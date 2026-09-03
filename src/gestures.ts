import type { ButtonAction, ButtonName } from './proto.ts';

export type Gesture =
  | { kind: 'toggle' }
  | { kind: 'reset' }
  | { kind: 'switch' }
  | { kind: 'adjust'; deltaMs: number };

export interface GestureOptions {
  toggleButton: ButtonName;
  /** Pressing the dial in. On this hardware that arrives as the `ok` button. */
  switchButton: ButtonName;
  /**
   * Optional extra button bound to reset. Defaults to unbound, because the only
   * spare button is BACK and the firmware uses it to pop its own navigation
   * stack — binding it throws the widget off the panel. Reset lives on a
   * double-click of the dial instead.
   */
  resetButton: ButtonName | null;
  /** Two dial clicks inside this window are a reset rather than two switches. */
  doubleTapMs: number;
  coarseStepSeconds: number;
  fineStepSeconds: number;
}

/**
 * Maps the Bar's physical controls onto timer actions.
 *
 *   START               start / pause
 *   dial click          switch A <-> B
 *   dial double-click   reset
 *   dial turn           adjust by `coarseStepSeconds`
 *   click + turn        adjust by `fineStepSeconds`
 *
 * START acts on the press, with nothing to wait for — start/pause is instant,
 * which is the one place latency is really felt.
 *
 * The dial carries the rest. A click has to wait out `doubleTapMs` to know
 * whether a second one is coming, so switching costs that much latency; that is
 * an acceptable trade on an action you use far less than start/pause, and it
 * keeps reset off the firmware-owned BACK button.
 *
 * Turning while the dial is held gives fine steps, and suppresses the switch on
 * release so click-and-spin doesn't also flip timers.
 *
 * Every interval is measured with the *device's* clock, never arrival time. On a
 * laggy link a stall delivers buffered events together, and two clicks that
 * arrive back-to-back would otherwise look like a double-click and fire a
 * spurious reset.
 */
export class GestureRecognizer {
  private switchDown = false;
  private spunWhileDown = false;
  /** Device timestamps of the clicks in the window currently being judged. */
  private clickTimes: number[] = [];
  private clickTimer: NodeJS.Timeout | null = null;

  private readonly options: GestureOptions;
  private readonly emit: (gesture: Gesture) => void;

  constructor(options: GestureOptions, emit: (gesture: Gesture) => void) {
    this.options = options;
    this.emit = emit;
  }

  /** `atMs` is the device's own clock for this event, or 0 if unavailable. */
  handle(button: ButtonName, action: ButtonAction, atMs = 0): void {
    const { toggleButton, resetButton, switchButton } = this.options;

    if (action === 'press') {
      if (button === toggleButton) this.emit({ kind: 'toggle' });
      else if (resetButton !== null && button === resetButton) this.emit({ kind: 'reset' });
      else if (button === switchButton) {
        this.switchDown = true;
        this.spunWhileDown = false;
      }
      return;
    }

    if (button !== switchButton || !this.switchDown) return;
    this.switchDown = false;

    // A turn while held meant "fine adjust", not a click at all.
    if (this.spunWhileDown) {
      this.spunWhileDown = false;
      return;
    }

    this.clickTimes.push(atMs > 0 ? atMs : Date.now());
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => this.resolveClicks(), this.options.doubleTapMs);
  }

  /**
   * Decide what a run of dial clicks meant, once the window has closed.
   *
   * Two or more clicks count as a reset only if the *device* says they really
   * were that close together. Clicks that merely arrived together after a
   * network stall fall through to a switch.
   */
  private resolveClicks(): void {
    this.clickTimer = null;
    const times = this.clickTimes;
    this.clickTimes = [];
    if (times.length === 0) return;

    const spread = times[times.length - 1]! - times[0]!;
    if (times.length >= 2 && spread >= 0 && spread <= this.options.doubleTapMs) {
      this.emit({ kind: 'reset' });
      return;
    }
    this.emit({ kind: 'switch' });
  }

  /** One detent of the dial. `delta` is +/-1; one detent is always one step. */
  handleEncoder(delta: number): void {
    if (delta === 0) return;
    if (this.switchDown) this.spunWhileDown = true;

    const stepSeconds = this.switchDown
      ? this.options.fineStepSeconds
      : this.options.coarseStepSeconds;
    this.emit({ kind: 'adjust', deltaMs: delta * stepSeconds * 1000 });
  }

  dispose(): void {
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = null;
    this.clickTimes = [];
    this.switchDown = false;
    this.spunWhileDown = false;
  }
}
