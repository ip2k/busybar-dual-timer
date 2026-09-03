import type { DisplayElement, DrawPayload } from './api.ts';
import type { Snapshot } from './timers.ts';

export const WIDTH = 72;
export const HEIGHT = 16;

const DIM_ALPHA = '55';

function withAlpha(color: string, alpha: string): string {
  return `${color.slice(0, 7)}${alpha}`;
}

export function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export interface RenderState {
  snapshot: Snapshot;
  /** Drives the paused blink and the expiry flash. */
  blinkOn: boolean;
  /**
   * True while the expiry alarm is sounding, as opposed to the quiet "DONE"
   * that holds afterwards. The alarm inverts the whole panel on each blink;
   * the hold is dim text on black.
   */
  alarm?: boolean;
}

/**
 * Fonts are the device's own, so the widget reads as native rather than as
 * something bolted on. The names map to real firmware fonts:
 *
 *   tiny → busy_tiny            small → busy_regular_5    normal → busy_regular_7
 *   condensed → busy_condensed_7   bold → busy_bold_7     large → busy_regular_9
 *   extra_large → busy_bold_10     global → lana_pixel_11
 *
 * The built-in clock app draws its time in `bold` (busy_bold_7) and its
 * secondary text in `small` (busy_regular_5). This widget has only one line to
 * show, so it goes a size bigger: `extra_large` (busy_bold_10) is the same
 * family, heavier and taller, and measured at 53 of 72 columns for `1:01:01` —
 * so it fits every duration this can display up to 9:59:59.
 */
function timeFont(text: string): 'extra_large' | 'condensed' {
  // Past 7 characters even bold_10 overflows 72px; condensed is the fallback.
  return text.length <= 7 ? 'extra_large' : 'condensed';
}

/**
 * Fully transparent. Used to keep an element present but invisible.
 *
 * The element id set must not change between frames: `index.ts` clears the
 * display whenever it does, and the firmware's own screen is visible in the gap
 * between that clear and the next draw. Verified on hardware — alpha `00`
 * renders as nothing at all, so a placeholder costs only a few bytes.
 */
const INVISIBLE = '#00000000';

/**
 * Every frame emits the same four elements in the same order, whatever the
 * state. Unused ones go transparent rather than being omitted.
 *
 * `flash` is first so it sits behind the text.
 */
function elementsFor(state: RenderState): DisplayElement[] {
  const { snapshot, blinkOn } = state;
  const expired = snapshot.phase === 'expired';
  const paused = snapshot.phase === 'paused';
  const idle = snapshot.phase === 'idle';

  const text = expired ? `${snapshot.label} DONE` : formatDuration(snapshot.remainingMs);
  const barWidth = expired ? 0 : Math.max(0, Math.min(WIDTH, Math.round(WIDTH * snapshot.fraction)));

  // Expiry has three looks, not two. During the alarm the panel *inverts* on
  // each blink — a solid field of the timer's colour with the text knocked out
  // black, alternating with the same text lit on black. Inverting the whole
  // 72x16 field is far more noticeable across a room than blinking text alone,
  // which is the entire job of an alarm. Once the alarm ends, "DONE" stays up
  // dim until it is acknowledged or released.
  const alarming = expired && state.alarm === true;
  const inverted = alarming && blinkOn;

  let timeColor: string;
  if (expired) {
    if (inverted) timeColor = '#000000FF';
    else if (alarming) timeColor = snapshot.color;
    else timeColor = withAlpha(snapshot.color, '66');
  } else if (paused && !blinkOn) timeColor = withAlpha(snapshot.color, DIM_ALPHA);
  else timeColor = snapshot.color;

  return [
    {
      id: 'flash',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: WIDTH,
      height: HEIGHT,
      display: 'front',
      fill: 'solid',
      fill_colors: [expired ? (inverted ? snapshot.color : '#000000FF') : INVISIBLE],
      border_width: 0,
    },
    {
      id: 'bar',
      type: 'rectangle',
      x: 0,
      y: HEIGHT - 1,
      // Never zero-width: keep the element real and hide it with alpha instead.
      width: Math.max(1, barWidth),
      height: 1,
      display: 'front',
      fill: 'solid',
      fill_colors: [barWidth > 0 ? withAlpha(snapshot.color, paused || idle ? '77' : 'FF') : INVISIBLE],
      border_width: 0,
    },
    {
      id: 'label',
      type: 'text',
      x: 1,
      y: 1,
      align: 'top_left',
      display: 'front',
      text: snapshot.label,
      font: 'small',
      color: expired ? INVISIBLE : idle ? withAlpha(snapshot.color, '99') : snapshot.color,
    },
    {
      id: 'time',
      type: 'text',
      x: expired ? 36 : 39,
      y: expired ? 8 : 7,
      align: 'center',
      display: 'front',
      text,
      font: expired ? 'bold' : timeFont(text),
      color: timeColor,
    },
  ];
}

export function buildPayload(
  state: RenderState,
  options: { applicationName: string; priority: number; ledColor?: string; ledBlink?: boolean },
): DrawPayload {
  const { phase, ledColor } = state.snapshot;
  const expired = phase === 'expired';
  const payload: DrawPayload = {
    application_name: options.applicationName,
    priority: options.priority,
    elements: elementsFor(state),
  };

  // Including this field fires the firmware's Notification preset: three blinks
  // at maximum brightness, in this colour. That is the only light behaviour the
  // HTTP API can reach — there is no steady-on and no pattern control. The
  // caller decides *when* to fire it; see `behavior.ledMode`.
  if (options.ledBlink) payload.led_notification_color = expired ? (options.ledColor ?? ledColor) : ledColor;
  return payload;
}

/** Cheap identity for a rendered frame, so we only POST when something changed. */
export function signature(payload: DrawPayload): string {
  return JSON.stringify(payload.elements) + (payload.led_notification_color ?? '');
}
