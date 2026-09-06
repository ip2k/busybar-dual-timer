/**
 * Run the built device bundle under Node, against stubs for the runtime the
 * firmware provides.
 *
 * This exists because three consecutive on-device runs rebooted the Bar, and
 * each attempt costs a physical reboot and a person standing at the device. A
 * bundle that misbehaves in this harness has no business being installed.
 *
 * What it can prove: that the bundle parses, that its control flow reaches the
 * end, that every request it makes is well-formed, and — the one that matters
 * most — that it never leaves a response body unread, since an unread body
 * permanently leaks the request inside js_fetch.c.
 *
 * What it cannot prove: anything about firmware memory, threads or timing.
 * Those need the device.
 *
 *   node test/js-app-harness.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(ROOT, '.js-build/app/dev.ip2k.dualtimer/scripts/main.js');

if (!existsSync(BUNDLE)) {
  console.error('no bundle; run `node tools/js-app.mjs build` first');
  process.exit(2);
}

const requests = [];
let unreadBodies = 0;
let openRequests = 0;

class StubRequest {
  constructor(url, options = {}) {
    this.url = url;
    this.method = options.method ?? 'GET';
    this.body = options.body;
  }
}

/**
 * A response whose body must be consumed. `bodyRead` is checked at the end:
 * anything left unread would leak on the real device.
 */
function stubResponse(request) {
  const response = {
    status: 200,
    ok: true,
    bodyRead: false,
    text() {
      response.bodyRead = true;
      openRequests--;
      return Promise.resolve('{"result":"OK"}');
    },
    json() {
      response.bodyRead = true;
      openRequests--;
      return Promise.resolve({ result: 'OK' });
    },
  };
  return response;
}

const responses = [];

globalThis.Request = StubRequest;
globalThis.fetch = (request) => {
  const entry = { url: request.url, method: request.method, body: request.body };
  requests.push(entry);

  // Every request must be addressed to the device over loopback.
  if (!request.url.startsWith('http://127.0.0.1/')) {
    throw new Error(`request to a non-loopback host: ${request.url}`);
  }
  if (entry.body !== undefined) JSON.parse(entry.body); // must be valid JSON

  openRequests++;
  const response = stubResponse(request);
  responses.push(response);
  return Promise.resolve(response);
};

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// The firmware has no `performance`; the bundle's own preamble shims it. Delete
// it so the harness exercises the same path the device does.
delete globalThis.performance;

// Keep a handle on the real console before replacing the global, or this
// script's own reporting disappears into the capture buffer.
const out = console;
const logs = [];
globalThis.console = {
  ...console,
  info: (...a) => logs.push(a.join(' ')),
  log: (...a) => logs.push(a.join(' ')),
  error: (...a) => logs.push('ERROR ' + a.join(' ')),
};

const started = Date.now();
try {
  await import(BUNDLE);
} catch (e) {
  out.error('bundle threw on import:', e);
  process.exit(1);
}

// The demo is time-based: 8s A, 6s alarm, 5s B, 6s alarm, plus slack.
await new Promise((r) => setTimeout(r, 32_000));

unreadBodies = responses.filter((r) => !r.bodyRead).length;

const failures = [];
const complete = store.get('stage') === 'complete';
if (!complete) failures.push(`did not reach 'complete' (last stage: ${store.get('stage')})`);
if (unreadBodies > 0) failures.push(`${unreadBodies} response bodies never read (these leak on device)`);
if (requests.length === 0) failures.push('made no requests at all');
if (logs.some((l) => l.startsWith('ERROR'))) {
  failures.push(`errors logged: ${logs.filter((l) => l.startsWith('ERROR')).join(' | ')}`);
}

out.log(`ran ${((Date.now() - started) / 1000).toFixed(1)}s`);
out.log(`requests: ${requests.length}, bodies read: ${responses.length - unreadBodies}/${responses.length}`);
out.log(`final stage: ${store.get('stage')}`);
const draws = requests.filter((r) => r.url.includes('/api/display/draw')).length;
const audio = requests.filter((r) => r.url.includes('/api/audio/play')).length;
out.log(`draws: ${draws}, audio: ${audio}`);

if (failures.length) {
  out.error('\nFAILED:');
  for (const f of failures) out.error(`  - ${f}`);
  process.exit(1);
}
out.log('\njs-app harness: ok');
out.log(logs.join('\n'));
