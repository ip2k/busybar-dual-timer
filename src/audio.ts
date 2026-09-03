/**
 * Turn an ordinary `.wav` file into what the Bar actually plays.
 *
 * The firmware wants **headerless** PCM: signed 16-bit little-endian, mono,
 * 44.1 kHz. A real WAV — the thing you get from every audio tool on earth — has
 * a RIFF header, and is very often stereo, or 48 kHz, or 24-bit. Uploading one
 * unconverted produces silence or noise, with a cheerful `200 OK` either way,
 * which is a miserable thing to debug.
 *
 * So we convert. For WAV that is a small pure function rather than a
 * dependency: the whole job is parsing a couple of chunks, averaging channels
 * and interpolating samples.
 *
 * Handled here, with no external tools: PCM integer at 8/16/24/32-bit and IEEE
 * float at 32/64-bit, any channel count, any sample rate.
 *
 * Compressed formats (mp3, flac, ogg, m4a, aiff) genuinely need a decoder, which
 * is orders of magnitude more code than the zero-dependency rule allows. Those
 * are detected here and handed to ffmpeg by `audio-file.ts`, or refused with the
 * exact command to run. A compressed WAV (ADPCM) is likewise rejected with a
 * clear message rather than silently producing noise.
 *
 * This module stays pure so it can be tested without a filesystem; everything
 * that touches disk or spawns a process lives in `audio-file.ts`.
 */

const TARGET_RATE = 44100;
export const TARGET_FORMAT = 's16le mono 44100Hz';

/**
 * Bounds on what will be converted. A chime that plays three times, a second
 * apart, has no business being longer than this — and the limit is what keeps
 * a hostile file from turning into gigabytes of PCM: the resampler multiplies
 * the sample count by 44100 / sampleRate, so a header claiming 1 Hz would
 * expand a 20 KB file into 1.7 GB before anything noticed.
 */
export const MAX_SOUND_SECONDS = 30;
/** Refuse to read files bigger than this at all; nothing under the duration cap comes close. */
export const MAX_SOUND_BYTES = 8 * 1024 * 1024;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192_000;
const MAX_CHANNELS = 8;

function tooLong(seconds: number): Error {
  return new Error(
    `${seconds.toFixed(1)}s of audio is too long for a chime (at most ${MAX_SOUND_SECONDS}s) — trim it`,
  );
}

export type AudioFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'mp4' | 'aiff' | 'raw';

/**
 * Identify a file by its magic bytes rather than its extension, because the
 * extension lies constantly — half the "`.wav`" files on the internet are
 * something else, and this project's own device format is a `.wav` that is not
 * a WAV at all.
 */
export function detectFormat(bytes: Uint8Array): AudioFormat {
  const tag = (at: number, length = 4) =>
    String.fromCharCode(...Array.from(bytes.subarray(at, at + length)));
  if (bytes.byteLength < 12) return 'raw';
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') return 'wav';
  if (tag(0) === 'fLaC') return 'flac';
  if (tag(0) === 'OggS') return 'ogg';
  if (tag(4) === 'ftyp') return 'mp4'; // .m4a / .aac / .mp4
  if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) return 'aiff';
  if (tag(0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame sync: 11 set bits.
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'mp3';
  return 'raw';
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** Seconds of audio. */
  duration: number;
}

export interface ConvertedAudio {
  pcm: Uint8Array;
  /** Human-readable account of what was done, for logging. */
  note: string;
  info: AudioInfo | null;
}

/** A RIFF/WAVE file begins "RIFF" .... "WAVE". */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

function readSamples(
  view: DataView,
  start: number,
  length: number,
  bitDepth: number,
  format: number,
): Float32Array {
  const bytesPerSample = bitDepth / 8;
  const count = Math.floor(length / bytesPerSample);
  const out = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const at = start + i * bytesPerSample;
    if (format === FORMAT_FLOAT) {
      out[i] = bitDepth === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
      continue;
    }
    switch (bitDepth) {
      case 8:
        // 8-bit WAV is unsigned, centred on 128.
        out[i] = (view.getUint8(at) - 128) / 128;
        break;
      case 16:
        out[i] = view.getInt16(at, true) / 32768;
        break;
      case 24: {
        const lo = view.getUint8(at);
        const mid = view.getUint8(at + 1);
        const hi = view.getInt8(at + 2); // top byte carries the sign
        out[i] = ((hi << 16) | (mid << 8) | lo) / 8388608;
        break;
      }
      case 32:
        out[i] = view.getInt32(at, true) / 2147483648;
        break;
      default:
        throw new Error(`unsupported bit depth ${bitDepth}`);
    }
  }
  return out;
}

/** Average all channels down to one. */
function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels === 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[frame * channels + c]!;
    out[frame] = sum / channels;
  }
  return out;
}

/**
 * Linear interpolation. Not the finest resampler ever written, but this is a
 * notification chime, and the alternative is a dependency.
 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const frames = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    out[i] = samples[index]! * (1 - fraction) + samples[next]! * fraction;
  }
  return out;
}

function toInt16Bytes(samples: Float32Array): Uint8Array {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Parse a RIFF/WAVE file and return device-ready PCM. */
export function decodeWav(bytes: Uint8Array): ConvertedAudio {
  if (!isWav(bytes)) throw new Error('not a RIFF/WAVE file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataAt = -1;
  let dataLength = 0;

  // Walk the chunk list. Chunks are padded to even lengths.
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;

    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in the GUID's first two bytes.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataAt = body;
      dataLength = Math.min(size, bytes.byteLength - body);
    }

    at = body + size + (size % 2);
  }

  if (dataAt < 0) throw new Error('no data chunk found');
  if (!channels || !sampleRate || !bitDepth) throw new Error('no readable fmt chunk found');
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new Error(
      `unsupported WAV encoding (format ${format}); this reader handles uncompressed PCM and float only — ` +
        're-export as 16-bit PCM',
    );
  }
  // The header is untrusted. Everything below sizes allocations from it.
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`implausible sample rate ${sampleRate} Hz (expected ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE})`);
  }
  if (channels > MAX_CHANNELS) throw new Error(`implausible channel count ${channels} (at most ${MAX_CHANNELS})`);
  const seconds = dataLength / (channels * (bitDepth / 8)) / sampleRate;
  if (seconds > MAX_SOUND_SECONDS) throw tooLong(seconds);

  const raw = readSamples(view, dataAt, dataLength, bitDepth, format);
  const mono = toMono(raw, channels);
  const resampled = resample(mono, sampleRate, TARGET_RATE);
  const pcm = toInt16Bytes(resampled);

  const changes: string[] = [];
  if (channels > 1) changes.push(`${channels}ch -> mono`);
  if (sampleRate !== TARGET_RATE) changes.push(`${sampleRate}Hz -> ${TARGET_RATE}Hz`);
  if (bitDepth !== 16 || format === FORMAT_FLOAT) {
    changes.push(`${format === FORMAT_FLOAT ? 'float' : 'int'}${bitDepth} -> int16`);
  }
  changes.push('stripped RIFF header');

  return {
    pcm,
    note: changes.join(', '),
    info: {
      sampleRate,
      channels,
      bitDepth,
      duration: mono.length / sampleRate,
    },
  };
}

/**
 * Accept whatever the user put in `assets/` and return something the device can
 * play. A real WAV is converted; anything else is assumed to already be raw PCM
 * in the device's format and passed through untouched.
 *
 * This is the pure, dependency-free path. For compressed formats see
 * `prepareAudioFile`, which needs a file on disk and an `ffmpeg` binary.
 */
export function toDevicePcm(bytes: Uint8Array): ConvertedAudio {
  if (isWav(bytes)) return decodeWav(bytes);
  const seconds = bytes.byteLength / 2 / TARGET_RATE;
  if (seconds > MAX_SOUND_SECONDS) throw tooLong(seconds);
  return {
    pcm: bytes,
    note: 'no RIFF header — assuming it is already raw s16le mono 44.1kHz PCM',
    info: null,
  };
}

/** Quote for a POSIX shell: single quotes, with any embedded single quote closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a user should run to convert something by hand.
 *
 * This gets pasted into a terminal, so the path is quoted in a way no filename
 * can break out of — `"$(...)"` would still expand inside double quotes.
 */
export function ffmpegCommand(input: string, output = 'assets/chime.wav'): string {
  return (
    `ffmpeg -i ${shellQuote(input)} -t ${MAX_SOUND_SECONDS} -f s16le -acodec pcm_s16le -ac 1 ` +
    `-ar ${TARGET_RATE} ${shellQuote(output)}`
  );
}

export function describeUnsupported(format: AudioFormat, file: string): string {
  return (
    `${file} is ${format.toUpperCase()}, which needs decoding this project cannot do on its own — ` +
    'a compressed-audio decoder is far more code than the zero-dependency rule allows. ' +
    'Install ffmpeg and it will be converted automatically, or convert it yourself with:\n  ' +
    ffmpegCommand(file)
  );
}
