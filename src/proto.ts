/**
 * Minimal protobuf reader for the BUSY Bar status stream.
 *
 * The device streams `BSB_State.State` messages over /api/status/ws. We only
 * care about input events, so rather than pulling in a protobuf runtime we walk
 * the wire format and decode just the subtree we need, skipping everything else
 * (notably field 10, the front-display frame, which is most of the traffic).
 *
 * Schema (github.com/busy-app/busybar-protobuf):
 *   State        { fixed64 timestamp = 1; repeated StateUpdate updates = 2; Error error = 3 }
 *   StateUpdate  { oneof state { ... Frame frame = 10; InputEvent input = 11; Timer timer = 12; ... } }
 *   InputEvent   { oneof event { ButtonEvent button_event = 1; SwitchEvent switch_event = 2; EncoderEvent encoder_event = 3 } }
 *   ButtonEvent  { Button button = 1; ButtonAction action = 2 }
 *
 * Careful: proto3 omits fields holding their default, and the first entry of an
 * enum IS the default. A press of OK (button 0, action 0) therefore arrives as a
 * completely empty ButtonEvent — hence the explicit `0` defaults below.
 */

export const BUTTONS = ['ok', 'back', 'start'] as const;
export const BUTTON_ACTIONS = ['press', 'release'] as const;
export const SWITCH_POSITIONS = ['busy', 'custom', 'off', 'apps', 'settings'] as const;

export type ButtonName = (typeof BUTTONS)[number];
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export type SwitchPosition = (typeof SWITCH_POSITIONS)[number];

export type InputEvent =
  | { kind: 'button'; button: ButtonName; action: ButtonAction }
  | { kind: 'switch'; position: SwitchPosition }
  | { kind: 'encoder'; delta: number };

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

class Reader {
  private readonly buf: Uint8Array;
  private pos: number;
  private readonly end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      // Ten bytes is the longest valid varint, and a negative int32 or int64
      // always uses all ten. Values past 2^53 lose precision here, which is
      // fine: nothing this decoder reads is that large, and an out-of-range
      // enum simply fails its table lookup. Rejecting at nine used to drop the
      // whole message for a field the decoder was only skipping.
      if (shift > 63) throw new Error('varint too long');
    }
    throw new Error('truncated varint');
  }

  /** @returns [fieldNumber, wireType] */
  tag(): [number, number] {
    const key = this.varint();
    return [key >>> 3, key & 7];
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.end) throw new Error('truncated length-delimited field');
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  sub(): Reader {
    const slice = this.bytes();
    return new Reader(slice, 0, slice.length);
  }

  /**
   * Little-endian fixed64 as a JS number. The device puts Unix milliseconds
   * here, which is ~1.8e12 — far below 2^53, so precision is not a concern.
   */
  fixed64AsNumber(): number {
    if (this.pos + 8 > this.end) throw new Error('truncated fixed64');
    let value = 0;
    for (let i = 7; i >= 0; i--) value = value * 256 + this.buf[this.pos + i]!;
    this.pos += 8;
    return value;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_I64:
        this.pos += 8;
        return;
      case WIRE_LEN: {
        // `this.pos += this.varint()` would be wrong: JS reads the old `pos`
        // before varint() advances it past its own bytes.
        const length = this.varint();
        this.pos += length;
        return;
      }
      case WIRE_I32:
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}

function enumAt<T extends readonly string[]>(table: T, index: number): T[number] | undefined {
  return table[index];
}

function parseButtonEvent(reader: Reader): InputEvent | null {
  let button = 0;
  let action = 0;
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (field === 1 && wire === WIRE_VARINT) button = reader.varint();
    else if (field === 2 && wire === WIRE_VARINT) action = reader.varint();
    else reader.skip(wire);
  }
  const name = enumAt(BUTTONS, button);
  const act = enumAt(BUTTON_ACTIONS, action);
  if (!name || !act) return null;
  return { kind: 'button', button: name, action: act };
}

function parseSwitchEvent(reader: Reader): InputEvent | null {
  let position = 0;
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (field === 1 && wire === WIRE_VARINT) position = reader.varint();
    else reader.skip(wire);
  }
  const name = enumAt(SWITCH_POSITIONS, position);
  return name ? { kind: 'switch', position: name } : null;
}

function parseEncoderEvent(reader: Reader): InputEvent {
  let delta = 0;
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (field === 1 && wire === WIRE_VARINT) {
      const raw = reader.varint();
      delta = (raw >>> 1) ^ -(raw & 1); // zigzag, sint32
    } else reader.skip(wire);
  }
  return { kind: 'encoder', delta };
}

function parseInputEvent(reader: Reader): InputEvent | null {
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (wire !== WIRE_LEN) {
      reader.skip(wire);
      continue;
    }
    if (field === 1) return parseButtonEvent(reader.sub());
    if (field === 2) return parseSwitchEvent(reader.sub());
    if (field === 3) return parseEncoderEvent(reader.sub());
    reader.skip(wire);
  }
  return null;
}

export interface ParsedState {
  /**
   * The device's own clock, in Unix ms, from `State.timestamp`. Zero if the
   * message carried none.
   *
   * This matters for anything that measures the interval *between* inputs. Local
   * arrival time is a property of the network, not of what the user did: a Wi-Fi
   * stall that releases three buffered detents at once makes them look
   * simultaneous. The device timestamp is immune to that.
   */
  timestampMs: number;
  events: InputEvent[];
}

/** Pull the timestamp and every input event out of one `State` message. */
export function parseState(message: Uint8Array): ParsedState {
  const events: InputEvent[] = [];
  let timestampMs = 0;
  const reader = new Reader(message);
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (field === 1 && wire === WIRE_I64) {
      timestampMs = reader.fixed64AsNumber();
    } else if (field === 2 && wire === WIRE_LEN) {
      const update = reader.sub();
      while (!update.done) {
        const [updateField, updateWire] = update.tag();
        if (updateField === 11 && updateWire === WIRE_LEN) {
          const event = parseInputEvent(update.sub());
          if (event) events.push(event);
        } else {
          update.skip(updateWire);
        }
      }
    } else {
      reader.skip(wire);
    }
  }
  return { timestampMs, events };
}

/** Convenience wrapper for callers that only care about the events. */
export function parseInputEvents(message: Uint8Array): InputEvent[] {
  return parseState(message).events;
}
