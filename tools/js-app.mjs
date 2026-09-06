#!/usr/bin/env node
/**
 * Build, install and debug the on-device JavaScript app.
 *
 *   node tools/js-app.mjs build      compile src/ + js-app/src/ into one file
 *   node tools/js-app.mjs install    upload the built app to the Bar
 *   node tools/js-app.mjs enable     switch on JS apps in the APPS menu
 *   node tools/js-app.mjs disable    switch them off again
 *   node tools/js-app.mjs logs       dump the device log and show our lines
 *   node tools/js-app.mjs crumbs     read breadcrumbs that survive a crash
 *   node tools/js-app.mjs list       show what is installed in /ext/user_assets
 *   node tools/js-app.mjs remove     delete the app from the Bar
 *
 * `--host <addr>` overrides the address; otherwise `device.host` from
 * config.json is used, falling back to the USB address.
 *
 * Why this bundles rather than depending on a bundler: the firmware links JS
 * modules with a NULL resolver (see docs/js-port.md), so `import './other.js'`
 * cannot load a sibling file on the device and everything must arrive as one
 * script. The import graph here is four files deep and acyclic, so resolving it
 * is about thirty lines — the same argument that keeps the protobuf reader in
 * this repo rather than a package.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, '.js-build');
const ENTRY = resolve(BUILD, 'js-app/src/main.js');
const OUT_DIR = resolve(BUILD, 'app');
const MANIFEST = resolve(ROOT, 'js-app/appmeta/manifest.json');
const APPS_ROOT = '/ext/user_assets';

/* ----------------------------------------------------------------- bundle */

/** tsc emits one import per line, which keeps this honest and simple. */
const IMPORT_RE = /^\s*import\s+[^;]*?from\s*["'](\.[^"']+)["'];?[ \t]*$/gm;

/**
 * Depth-first post-order walk of the import graph, so a module is emitted only
 * after everything it depends on. `seen` also makes this safe against a diamond
 * (two modules importing the same third) — it is emitted once.
 */
function collect(file, seen = new Set(), order = []) {
  const path = resolve(file);
  if (seen.has(path)) return order;
  seen.add(path);
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    collect(resolve(dirname(path), match[1]), seen, order);
  }
  order.push({ path, source });
  return order;
}

/**
 * Concatenating modules works only because they end up sharing one scope, which
 * makes `import` unnecessary and `export` meaningless. Both are removed rather
 * than rewritten. A name collision between two modules would break this
 * silently, so `build` checks for one.
 */
function strip(source) {
  return source
    .replace(IMPORT_RE, '')
    .replace(/^\s*export\s*\{[^}]*\};?[ \t]*$/gm, '')
    .replace(/^(\s*)export\s+(?=(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var)\b)/gm, '$1');
}

/**
 * Strip comments. This repo comments heavily on purpose, which is right for the
 * source and wrong for the device: the entire script is read into a JS heap of
 * at most 256 KiB and parsed there, so prose costs real memory. Naive but safe
 * enough here — it skips anything inside a string or a regex literal.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += source[i++];
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else {
      out += source[i++];
    }
  }
  // Collapse the blank lines the stripping leaves behind.
  return out.replace(/\n{3,}/g, '\n\n');
}

/** Top-level declarations, used to catch collisions between concatenated files. */
function declarations(source) {
  const names = [];
  for (const m of source.matchAll(/^(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1]);
  }
  return names;
}

function build() {
  rmSync(BUILD, { recursive: true, force: true });
  execFileSync('npx', ['tsc', '-p', 'js-app/tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });

  const modules = collect(ENTRY);
  const seenNames = new Map();
  for (const module of modules) {
    for (const name of declarations(strip(module.source))) {
      const previous = seenNames.get(name);
      if (previous) {
        throw new Error(`name collision bundling ${module.path}: "${name}" already declared in ${previous}`);
      }
      seenNames.set(name, module.path);
    }
  }

  const preamble = [
    '// Generated by tools/js-app.mjs - do not edit.',
    '// Bundled because the firmware links JS modules with a NULL resolver and',
    '// cannot load sibling files. See docs/js-port.md.',
    '',
    '// clock.ts wants a monotonic clock. JerryScript exposes no such thing -',
    '// there is no `performance` - so this falls back to wall time on device.',
    '// That is a real behavioural difference, not a shim detail: see the',
    '// "Monotonic time" section of docs/js-port.md.',
    'globalThis.__perfShimmed = typeof globalThis.performance === "undefined";',
    'if (globalThis.__perfShimmed) {',
    '  globalThis.performance = { now: function () { return Date.now(); } };',
    '}',
    '',
  ].join('\n');

  const body = modules.map((m) => stripComments(strip(m.source))).join('\n');

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const appDir = join(OUT_DIR, manifest.id);
  mkdirSync(join(appDir, 'appmeta'), { recursive: true });
  mkdirSync(join(appDir, 'scripts'), { recursive: true });

  const bundle = `${preamble}${body}\n`;
  writeFileSync(join(appDir, 'scripts', 'main.js'), bundle);
  writeFileSync(join(appDir, 'appmeta', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const raw = modules.reduce((total, m) => total + Buffer.byteLength(m.source), 0);
  console.log(
    `bundled ${modules.length} modules -> ${Buffer.byteLength(bundle)} bytes ` +
      `(${raw} before comment stripping)`,
  );
  console.log(`  modules: ${modules.map((m) => m.path.split('/').pop()).join(', ')}`);
  console.log(`  app id:  ${manifest.id} (heap ${manifest.heap_size_kib ?? 32} KiB)`);
  console.log(`  output:  ${appDir}`);
}

/* ----------------------------------------------------------------- device */

function host() {
  const flag = process.argv.indexOf('--host');
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  try {
    const config = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8'));
    if (config?.device?.host) return config.device.host;
  } catch {
    /* fall through to the USB address */
  }
  return '10.0.4.20';
}

async function call(method, path, body) {
  const response = await fetch(`http://${host()}${path}`, {
    method,
    body,
    headers: body ? { 'Content-Type': 'application/octet-stream' } : undefined,
    redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
  return text;
}

async function install() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const appDir = join(OUT_DIR, manifest.id);
  if (!existsSync(appDir)) throw new Error('nothing built yet - run `node tools/js-app.mjs build` first');

  const base = `${APPS_ROOT}/${manifest.id}`;
  for (const dir of [base, `${base}/appmeta`, `${base}/scripts`]) {
    // mkdir 400s when the directory already exists, which is not worth stopping for.
    await call('POST', `/api/storage/mkdir?path=${dir}`).catch(() => {});
  }

  for (const [local, remote] of [
    [join(appDir, 'appmeta', 'manifest.json'), `${base}/appmeta/manifest.json`],
    [join(appDir, 'scripts', 'main.js'), `${base}/scripts/main.js`],
  ]) {
    const data = readFileSync(local);
    await call('POST', `/api/storage/write?path=${remote}`, data);
    console.log(`uploaded ${remote} (${data.length} bytes)`);
  }

  console.log('scripts/:', await call('GET', `/api/storage/list?path=${base}/scripts`));
  console.log(`\nLaunch "${manifest.name}" from the APPS menu on the device.`);
}

async function logs() {
  await call('POST', '/api/log_dump?filename=jsapp');
  const text = await call('GET', '/api/storage/read?path=/ext/jsapp.txt');
  const lines = text.split('\n').filter((l) => /JsRunner|JsApp|dual-timer|probe|draw\]/i.test(l));
  console.log(lines.length ? lines.join('\n') : '(no JS runner lines in the log buffer)');
}

/**
 * Read the breadcrumbs the app leaves in localStorage.
 *
 * These survive a crash, which the console log does not: log_dump snapshots an
 * in-memory buffer that a reboot clears, so after a device-killing run the log
 * has nothing and this has the last stage reached.
 */
async function crumbs() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const path = `/ext/apps_data/jsrunner/${manifest.id}.localstorage.json`;
  try {
    console.log(await call('GET', `/api/storage/read?path=${path}`));
  } catch (e) {
    console.log(`no breadcrumbs at ${path} (${e.message})`);
  }
}

async function list() {
  const listing = JSON.parse(await call('GET', `/api/storage/list?path=${APPS_ROOT}`));
  for (const entry of listing.list) console.log(`${entry.type}\t${entry.name}`);
}

async function remove() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const base = `${APPS_ROOT}/${manifest.id}`;
  for (const path of [
    `${base}/appmeta/manifest.json`,
    `${base}/scripts/main.js`,
    `${base}/appmeta`,
    `${base}/scripts`,
    base,
  ]) {
    await call('POST', `/api/storage/remove?path=${path}`).catch((e) => console.log(`skip ${path}: ${e.message}`));
  }
  console.log('removed');
}

/**
 * JS apps are hidden behind a feature flag, and the flag is simply a file:
 * `apps_menu_is_js_apps_enabled()` in the firmware returns true if
 * /ext/apps_data/apps_menu/js_apps_enabled exists and is not a directory. Its
 * contents are never read.
 *
 * Until it exists the APPS menu shows a "Coming soon" placeholder *instead of*
 * enumerating /ext/user_assets, so a correctly installed app is simply
 * invisible. This is the first thing to check when an app does not appear.
 */
const JS_FLAG = '/ext/apps_data/apps_menu/js_apps_enabled';

async function enable() {
  await call('POST', `/api/storage/write?path=${JS_FLAG}`, Buffer.from('1'));
  const listing = JSON.parse(await call('GET', '/api/storage/list?path=/ext/apps_data/apps_menu'));
  const present = listing.list.some((e) => e.name === 'js_apps_enabled' && e.type === 'file');
  console.log(present ? `enabled: ${JS_FLAG} created` : 'FAILED: flag file not present after write');
  console.log('Leave the APPS menu and re-enter it — the flag is read when the menu opens.');
}

async function disable() {
  await call('POST', `/api/storage/remove?path=${JS_FLAG}`);
  console.log(`disabled: ${JS_FLAG} removed`);
}

const commands = { build, install, enable, disable, logs, crumbs, list, remove };
const command = process.argv[2];
if (!commands[command]) {
  console.error(`usage: node tools/js-app.mjs <${Object.keys(commands).join('|')}> [--host <addr>]`);
  process.exit(2);
}
await commands[command]();
