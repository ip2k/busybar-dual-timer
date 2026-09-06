#!/usr/bin/env node
/**
 * Capture real front-panel frames from a BUSY Bar, as PNGs.
 *
 * These are genuine photographs of the device's own output, not a simulation:
 * each frame is built by this project's real `render.ts`, POSTed to the Bar,
 * and then read back off the panel with `GET /api/screen?display=0`. That
 * round trip is the point — it is what makes the demo honest, and it catches
 * layout mistakes a local mock never would.
 *
 *   node tools/capture-frames.mjs [--host <addr>] [--out <dir>]
 *
 * Output feeds tools/render-demo.py, which maps the frames onto the device's
 * 3D model to produce docs/demo.gif.
 *
 * PNG is written by hand. It is a container around a zlib stream, which node
 * already has, so this stays inside the project's zero-dependency rule.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload } from '../src/render.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 72;
const HEIGHT = 16;
const APP = 'demo_capture';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('--host', 'x');
const OUT = resolve(ROOT, arg('--out', '.js-build/frames'));

/* --------------------------------------------------------------- PNG ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** `rgb` is width*height*3 bytes. Scale each pixel up into a block of `scale`. */
function png(rgb, width, height, scale = 1) {
  const w = width * scale;
  const h = height * scale;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0; // filter: none
    const sy = Math.floor(y / scale);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / scale);
      const src = (sy * width + sx) * 3;
      const dst = rowStart + 1 + x * 3;
      raw[dst] = rgb[src];
      raw[dst + 1] = rgb[src + 1];
      raw[dst + 2] = rgb[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ device ---- */

async function post(path, body) {
  const r = await fetch(`http://${HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  if (!r.ok) throw new Error(`draw -> ${r.status} ${await r.text()}`);
  await r.text();
}

/**
 * Read the panel back. The body is base64 of raw BGR triples despite the
 * image/bmp content type — see trap #9 in CLAUDE.md. Swapping to RGB here is
 * the whole reason the colours come out right.
 */
async function grab() {
  const r = await fetch(`http://${HOST}/api/screen?display=0`, { redirect: 'error' });
  const bgr = Buffer.from((await r.text()).trim(), 'base64');
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    rgb[i * 3] = bgr[i * 3 + 2];
    rgb[i * 3 + 1] = bgr[i * 3 + 1];
    rgb[i * 3 + 2] = bgr[i * 3];
  }
  return rgb;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------- sequence ---- */

const A = '#00E5FFFF';
const B = '#39FF14FF';

function snap(label, color, remainingMs, totalMs, phase) {
  return {
    index: label === 'A' ? 0 : 1,
    label,
    color,
    ledColor: color,
    phase,
    remainingMs,
    totalMs,
    fraction: totalMs === 0 ? 0 : remainingMs / totalMs,
  };
}

/** The story the demo tells: A counting, pausing, handing over to B, expiring. */
function sequence() {
  const frames = [];
  const push = (snapshot, blinkOn, alarm) => frames.push({ snapshot, blinkOn, alarm });

  const aTotal = 25 * 60 * 1000;
  for (let s = 0; s < 8; s++) push(snap('A', A, aTotal - s * 1000, aTotal, 'running'), true, false);
  for (let i = 0; i < 4; i++) push(snap('A', A, aTotal - 8000, aTotal, 'paused'), i % 2 === 0, false);

  const bTotal = 5 * 60 * 1000;
  for (let s = 0; s < 8; s++) push(snap('B', B, bTotal - s * 1000, bTotal, 'running'), true, false);
  for (let s = 0; s < 3; s++) push(snap('B', B, 3000 - s * 1000, bTotal, 'running'), true, false);
  for (let i = 0; i < 6; i++) push(snap('B', B, 0, bTotal, 'expired'), i % 2 === 0, true);
  for (let i = 0; i < 2; i++) push(snap('B', B, 0, bTotal, 'expired'), false, false);
  return frames;
}

/* -------------------------------------------------------------- main ---- */

if (HOST === 'x') {
  console.error('usage: node tools/capture-frames.mjs --host <addr> [--out <dir>]');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const frames = sequence();
console.log(`capturing ${frames.length} frames from ${HOST} -> ${OUT}`);

for (const [i, state] of frames.entries()) {
  const payload = buildPayload(state, { applicationName: APP, priority: 95 });
  await post('/api/display/draw', payload);
  // The panel needs a moment to actually show the draw before it is read back.
  await wait(220);
  const rgb = await grab();
  const name = join(OUT, `frame_${String(i).padStart(3, '0')}.png`);
  writeFileSync(name, png(rgb, WIDTH, HEIGHT, 1));
  const lit = (() => {
    let n = 0;
    for (let p = 0; p < WIDTH * HEIGHT; p++) if ((rgb[p * 3] + rgb[p * 3 + 1] + rgb[p * 3 + 2]) / 3 > 10) n++;
    return n;
  })();
  process.stdout.write(`\r  ${i + 1}/${frames.length}  lit=${String(lit).padStart(4)}   `);
}

await fetch(`http://${HOST}/api/display/draw?application_name=${APP}`, { method: 'DELETE' }).catch(() => {});
console.log(`\ndone. ${frames.length} PNGs in ${OUT}`);
