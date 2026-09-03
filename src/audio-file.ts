import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import {
  detectFormat,
  describeUnsupported,
  MAX_SOUND_BYTES,
  MAX_SOUND_SECONDS,
  toDevicePcm,
  type AudioFormat,
  type ConvertedAudio,
} from './audio.ts';

const TARGET_RATE = 44100;

/**
 * The I/O half of audio loading. `audio.ts` stays pure and testable; the parts
 * that touch the filesystem and shell out live here.
 */

/** Is there an `ffmpeg` on PATH? */
export function hasFfmpeg(): boolean {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

/**
 * Decode anything ffmpeg understands straight to the device's format.
 *
 * We ask for raw `s16le` on stdout, which means no container and no header —
 * exactly what the firmware wants, with no second conversion step.
 */
function convertWithFfmpeg(path: string): Uint8Array {
  // `-t` caps the decoded length at the source, so a three-minute track costs
  // thirty seconds of decoding rather than being rejected after the fact.
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-t', String(MAX_SOUND_SECONDS), '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(TARGET_RATE), '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`could not run ffmpeg: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim().split('\n').slice(-3).join('; ') || `exit ${result.status}`;
    throw new Error(`ffmpeg failed: ${detail}`);
  }
  const out = result.stdout;
  if (!out || out.byteLength === 0) throw new Error('ffmpeg produced no audio');
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Load a sound file and return PCM the Bar can play.
 *
 * WAV and raw PCM are handled in-process with no external tools. Compressed
 * formats (mp3, flac, ogg, m4a, aiff) need a real decoder, which is far more
 * code than this project's zero-dependency rule allows — so they go through
 * ffmpeg if it is installed, and otherwise fail with the exact command to run.
 */
export function loadAudioForDevice(path: string): ConvertedAudio {
  // Checked before the read: the file is loaded whole, and a raw file is
  // uploaded whole, so the size is the first thing to disbelieve.
  const size = statSync(path).size;
  if (size > MAX_SOUND_BYTES) {
    throw new Error(
      `${(size / 1048576).toFixed(1)} MB is too big for a chime (at most ${MAX_SOUND_BYTES / 1048576} MB) — trim it`,
    );
  }
  const bytes = new Uint8Array(readFileSync(path));
  const format: AudioFormat = detectFormat(bytes);

  if (format === 'wav' || format === 'raw') return toDevicePcm(bytes);

  if (!hasFfmpeg()) throw new Error(describeUnsupported(format, path));

  const pcm = convertWithFfmpeg(path);
  return {
    pcm,
    note: `${format.toUpperCase()} decoded with ffmpeg -> s16le mono ${TARGET_RATE}Hz`,
    info: { sampleRate: TARGET_RATE, channels: 1, bitDepth: 16, duration: pcm.byteLength / 2 / TARGET_RATE },
  };
}
