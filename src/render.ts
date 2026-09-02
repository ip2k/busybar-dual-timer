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
}

function timeFont(text: string): 'large' | 'condensed' | 'normal' {
  if (text.length <= 5) return 'large';
  if (text.length <= 7) return 'condensed';
  return 'normal';
}

function normalElements(state: RenderState): DisplayElement[] {
  const { snapshot, blinkOn } = state;
  const text = formatDuration(snapshot.remainingMs);
  const paused = snapshot.phase === 'paused';
  const idle = snapshot.phase === 'idle';
  const timeColor = paused && !blinkOn ? withAlpha(snapshot.color, DIM_ALPHA) : snapshot.color;
  const barWidth = Math.max(0, Math.min(WIDTH, Math.round(WIDTH * snapshot.fraction)));

  const elements: DisplayElement[] = [
    {
      id: 'label',
      type: 'text',
      x: 1,
      y: 1,
      align: 'top_left',
      display: 'front',
      text: snapshot.label,
      font: 'tiny',
      color: idle ? withAlpha(snapshot.color, '99') : snapshot.color,
    },
    {
      id: 'time',
      type: 'text',
      x: 39,
      y: 7,
      align: 'center',
      display: 'front',
      text,
      font: timeFont(text),
      color: timeColor,
    },
  ];

  if (barWidth > 0) {
    elements.push({
      id: 'bar',
      type: 'rectangle',
      x: 0,
      y: 15,
      width: barWidth,
      height: 1,
      display: 'front',
      fill: 'solid',
      fill_colors: [withAlpha(snapshot.color, paused || idle ? '77' : 'FF')],
      border_width: 0,
    });
  }

  return elements;
}

function expiredElements(state: RenderState): DisplayElement[] {
  const { snapshot, blinkOn } = state;
  if (!blinkOn) {
    return [
      {
        id: 'time',
        type: 'text',
        x: 36,
        y: 8,
        align: 'center',
        display: 'front',
        text: `${snapshot.label} DONE`,
        font: 'normal',
        color: withAlpha(snapshot.color, '66'),
      },
    ];
  }
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
      fill_colors: [snapshot.color],
      border_width: 0,
    },
    {
      id: 'time',
      type: 'text',
      x: 36,
      y: 8,
      align: 'center',
      display: 'front',
      text: `${snapshot.label} DONE`,
      font: 'normal',
      color: '#000000FF',
    },
  ];
}

export function buildPayload(
  state: RenderState,
  options: { applicationName: string; priority: number; ledColor?: string },
): DrawPayload {
  const expired = state.snapshot.phase === 'expired';
  const elements = expired ? expiredElements(state) : normalElements(state);
  const payload: DrawPayload = {
    application_name: options.applicationName,
    priority: options.priority,
    elements,
  };
  if (expired && options.ledColor) payload.led_notification_color = options.ledColor;
  return payload;
}

/** Cheap identity for a rendered frame, so we only POST when something changed. */
export function signature(payload: DrawPayload): string {
  return JSON.stringify(payload.elements) + (payload.led_notification_color ?? '');
}
