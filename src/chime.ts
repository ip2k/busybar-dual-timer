/**
 * The Bar plays raw PCM: signed 16-bit little-endian, mono, 44.1 kHz, uploaded
 * under a `.wav` filename. That is what busylib's ffmpeg conversion targets, so
 * we can synthesise a chime directly and skip the dependency.
 */
const SAMPLE_RATE = 44100;

interface Tone {
  freq: number;
  ms: number;
  gain?: number;
}

const DEFAULT_TONES: Tone[] = [
  { freq: 880, ms: 110 },
  { freq: 1174.66, ms: 110 },
  { freq: 1760, ms: 320, gain: 0.9 },
];

export function generateChime(tones: Tone[] = DEFAULT_TONES): Uint8Array {
  const totalSamples = tones.reduce((sum, tone) => sum + Math.round((tone.ms / 1000) * SAMPLE_RATE), 0);
  const buffer = Buffer.alloc(totalSamples * 2);
  let offset = 0;

  for (const tone of tones) {
    const samples = Math.round((tone.ms / 1000) * SAMPLE_RATE);
    const gain = tone.gain ?? 0.8;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      const progress = i / samples;
      // Quick attack, exponential decay — reads as a bell rather than a beep.
      const attack = Math.min(1, progress / 0.02);
      const decay = Math.exp(-4 * progress);
      const value = Math.sin(2 * Math.PI * tone.freq * t) * gain * attack * decay;
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), offset);
      offset += 2;
    }
  }

  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
