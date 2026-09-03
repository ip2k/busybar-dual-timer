import { parseState, type InputEvent } from './proto.ts';

export interface DisplayElementBase {
  id: string;
  type: 'text' | 'image' | 'animation' | 'countdown' | 'rectangle';
  x: number;
  y: number;
  display?: 'front' | 'back';
  align?:
    | 'top_left'
    | 'top_mid'
    | 'top_right'
    | 'mid_left'
    | 'center'
    | 'mid_right'
    | 'bottom_left'
    | 'bottom_mid'
    | 'bottom_right';
  timeout?: number;
}

export interface TextElement extends DisplayElementBase {
  type: 'text';
  text: string;
  font: 'tiny' | 'small' | 'normal' | 'condensed' | 'bold' | 'large' | 'extra_large' | 'global';
  color: string;
  width?: number;
}

export interface RectangleElement extends DisplayElementBase {
  type: 'rectangle';
  width: number;
  height: number;
  radius?: number;
  fill: 'none' | 'solid' | 'gradient_h' | 'gradient_v';
  fill_colors: string[];
  border_width: number;
  border_color?: string;
}

export type DisplayElement = TextElement | RectangleElement;

export interface DrawPayload {
  application_name: string;
  priority: number;
  led_notification_color?: string;
  elements: DisplayElement[];
}

export class BusyBarClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(host: string, apiToken?: string | null) {
    this.base = `http://${host}`;
    this.headers = apiToken ? { 'X-API-Token': apiToken } : {};
  }

  private async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      method,
      headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${response.status} ${body.trim()}`);
    }
    return response;
  }

  async version(): Promise<{ api_semver?: string }> {
    const response = await this.request('GET', '/api/version');
    return (await response.json()) as { api_semver?: string };
  }

  async draw(payload: DrawPayload): Promise<void> {
    await this.request('POST', '/api/display/draw', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async clear(applicationName: string): Promise<void> {
    await this.request('DELETE', `/api/display/draw?application_name=${encodeURIComponent(applicationName)}`);
  }

  async uploadAsset(applicationName: string, file: string, data: Uint8Array): Promise<void> {
    const query = `application_name=${encodeURIComponent(applicationName)}&file=${encodeURIComponent(file)}`;
    await this.request('POST', `/api/assets/upload?${query}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data as unknown as BodyInit,
    });
  }

  async playAudio(applicationName: string, source: { path?: string; stock_path?: string }): Promise<void> {
    await this.request('POST', '/api/audio/play', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_name: applicationName, ...source }),
    });
  }

  /** Push a synthetic key press (same endpoint the phone app uses). Handy for testing. */
  /** Current display brightness: "auto", or "0".."100" as a string. */
  async getBrightness(): Promise<string | null> {
    try {
      const response = await this.request('GET', '/api/display/brightness');
      const body = (await response.json()) as { value?: string };
      return body.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set display brightness. `auto` hands it to the ambient light sensor.
   *
   * This is a device-wide setting, not an app one — it outlives this process,
   * which is why the caller restores whatever was there before on shutdown.
   */
  async setBrightness(value: string): Promise<void> {
    await this.request('POST', `/api/display/brightness?value=${encodeURIComponent(value)}`);
  }

  async sendInput(key: string): Promise<void> {
    await this.request('POST', `/api/input?key=${encodeURIComponent(key)}`);
  }
}

/**
 * How far behind the newest device timestamp a message may be before it is
 * treated as stale rather than current.
 */
const STALE_MESSAGE_MS = 5000;

export interface StreamHandlers {
  /** `atMs` is the device's own clock for this message, or 0 if absent. */
  onInput: (event: InputEvent, atMs: number) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
}

/**
 * Keeps a WebSocket on /api/status/ws alive, reconnecting with backoff, and
 * hands every decoded input event to `onInput`.
 */
export class InputStream {
  private socket: WebSocket | null = null;
  private backoffMs = 500;
  /** Newest device timestamp seen, for spotting stale or replayed messages. */
  private newestDeviceMs = 0;
  private clockReported = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly host: string;
  private readonly handlers: StreamHandlers;
  private readonly options: { apiToken?: string | null; enableFrames?: boolean; maxEventsPerMessage?: number };

  constructor(
    host: string,
    handlers: StreamHandlers,
    options: { apiToken?: string | null; enableFrames?: boolean; maxEventsPerMessage?: number } = {},
  ) {
    this.host = host;
    this.handlers = handlers;
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private url(): string {
    const token = this.options.apiToken;
    const query = token ? `?x-api-token=${encodeURIComponent(token)}` : '';
    return `ws://${this.host}/api/status/ws${query}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.url());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.backoffMs = 500;
      // A device that rebooted comes back with a clock behind ours; keeping the
      // old high-water mark would reject everything it sends from then on.
      this.newestDeviceMs = 0;
      // The device starts streaming once it gets this handshake.
      socket.send(JSON.stringify({ enable: this.options.enableFrames ?? true }));
      this.handlers.onOpen?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') return;
      try {
        const { timestampMs, events } = parseState(new Uint8Array(event.data as ArrayBuffer));

        if (events.length > 0 && !this.clockReported) {
          this.clockReported = true;
          // Worth saying out loud: without a device clock, every interval falls
          // back to arrival time, which a laggy link distorts.
          if (timestampMs > 0) console.log(`[stream] device clock present (${timestampMs})`);
          else console.warn('[stream] device sent no timestamp — gesture timing will use arrival time');
        }

        // Out-of-order or replayed delivery: a message whose device clock is
        // well behind the newest we have seen did not just happen, whatever the
        // network says. Acting on it would apply stale input to current state.
        if (timestampMs > 0) {
          if (timestampMs < this.newestDeviceMs - STALE_MESSAGE_MS) {
            console.warn(
              `[stream] dropped a stale message (device clock ${this.newestDeviceMs - timestampMs}ms behind)`,
            );
            return;
          }
          if (timestampMs > this.newestDeviceMs) this.newestDeviceMs = timestampMs;
        }

        // The device has been seen delivering a large backlog of historical
        // input in a single message. Acting on it would fire dozens of
        // toggles/resets at once, so a burst that large is treated as a replay
        // and dropped. In normal use each input arrives in its own message.
        const limit = this.options.maxEventsPerMessage ?? 8;
        if (limit > 0 && events.length > limit) {
          console.warn(
            `[stream] dropped a burst of ${events.length} input events in one message ` +
              '(looks like a replayed backlog, not something a person did)',
          );
          return;
        }

        for (const input of events) this.handlers.onInput(input, timestampMs);
      } catch (error) {
        console.warn('[stream] failed to decode message:', (error as Error).message);
      }
    };

    socket.onerror = () => {
      /* onclose always follows; handled there */
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      this.handlers.onClose?.(`code ${event.code}`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
