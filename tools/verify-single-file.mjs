#!/usr/bin/env node
/*
 * verify-single-file.mjs
 *
 * Checks the generated single-file build.
 *
 *   A. structure  - every block the runtime reads is present, and the document
 *                   contains no stray "</script" that would end a block early.
 *   B. fidelity   - the inlined launcher, framework, StreamingAssets and intro
 *                   art decode back to byte-identical copies of the sources.
 *   C. runtime    - the *shipped* tools/solo-runtime.js is loaded in a DOM shim
 *                   and its URL resolver, byte-range handling, fetch() patch,
 *                   XMLHttpRequest patch and chunk-group loader are exercised.
 *   D. chunks     - the chunk manifest matches the files on disk, and the wasm
 *                   total matches the size the Unity launcher declares.
 *
 * Usage: node tools/verify-single-file.mjs [path/to/solo.html]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const htmlPath = path.resolve(args[0] || path.join(repoRoot, 'game', 'solo.html'));
const gameDir = path.dirname(htmlPath);
/* Synthetic builds (small stand-in chunks used to exercise --inline-all) cannot
 * match the wasm size the real launcher declares. */
const allowSizeMismatch = process.argv.includes('--allow-size-mismatch');

let failures = 0;
let checks = 0;
function ok(name, detail) { checks++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
function fail(name, detail) { failures++; checks++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
function check(name, cond, detail) { return cond ? ok(name, detail) : fail(name, detail); }
function section(t) { console.log('\n' + t); }

const html = fs.readFileSync(htmlPath, 'utf8');
console.log(`verifying ${path.relative(repoRoot, htmlPath)} (${(html.length / 1048576).toFixed(2)} MiB)`);

/* ------------------------------------------------------------------ */
section('A. structure');

function extractBlock(id, type) {
  const open = `<script type="${type}" id="${id}">`;
  const start = html.indexOf(open);
  if (start === -1) return null;
  const bodyStart = start + open.length;
  const end = html.indexOf('</script>', bodyStart);
  if (end === -1) return null;
  return { text: html.slice(bodyStart, end), start: bodyStart, end };
}

const loaderBlock = extractBlock('unity-loader-src', 'text/plain');
const frameworkBlock = extractBlock('unity-framework-src', 'text/plain');
const vfsBlock = extractBlock('vfs-data', 'application/json');
const configBlock = extractBlock('build-config', 'application/json');

check('unity-loader-src block present', !!loaderBlock);
check('unity-framework-src block present', !!frameworkBlock);
check('vfs-data block present', !!vfsBlock);
check('build-config block present', !!configBlock);

for (const id of ['unity-canvas', 'loading', 'status', 'progress', 'error', 'port-intro', 'chunk-picker']) {
  check(`markup id #${id}`, html.includes(`id="${id}"`));
}
check('folder picker input', /<input type="file" webkitdirectory/.test(html));

/* An id rule that sets `display` outranks the UA's [hidden]{display:none}, so any
 * element that uses the hidden attribute needs an explicit override. */
{
  const css = (/<style>([\s\S]*?)<\/style>/.exec(html) || [, ''])[1];
  const hiddenIds = new Set();
  for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
    if (/\shidden(\s|=|>)/i.test(tag)) {
      const m = /id="([a-z-]+)"/i.exec(tag);
      if (m) hiddenIds.add(m[1]);
    }
  }
  check('markup has hidden elements to check', hiddenIds.size > 0, [...hiddenIds].join(', '));
  const offenders = [];
  for (const rule of css.match(/#[a-z-]+\{[^}]*\}/gi) || []) {
    const id = /^#([a-z-]+)/i.exec(rule)[1];
    if (!hiddenIds.has(id)) continue;
    if (!/display\s*:/.test(rule)) continue;
    if (!new RegExp(`#${id}\\[hidden\\]\\s*\\{\\s*display\\s*:\\s*none`, 'i').test(css)) offenders.push('#' + id);
  }
  check('hidden elements are not overridden by their own display rule', offenders.length === 0,
    offenders.length ? 'no [hidden] override for ' + offenders.join(', ') : '');
}
check('intro art is a data: URI', /<img src="data:image\/png;base64,/.test(html));

/* The runtime is appended last and carries an id so it can be found exactly. */
const runtimeSource = extractBlock('solo-runtime', 'x') === null
  ? (() => {
      const open = html.indexOf('<script id="solo-runtime">');
      if (open === -1) return null;
      const bodyStart = open + '<script id="solo-runtime">'.length;
      return html.slice(bodyStart, html.indexOf('</script>', bodyStart));
    })()
  : null;
check('runtime script present', runtimeSource.includes('__SoloSingleFile'), `${runtimeSource.length} chars`);

/* A "</script" inside a text/plain block would have terminated it early and the
 * block we extracted would be truncated; compare against the real file size. */
/* The generator emits "\n" + payload + "\n" for every text block, so strip
 * exactly one newline from each end - a greedy strip would eat a newline that
 * belongs to the payload itself. */
const unescapeBlock = (t) => t.replace(/^\n/, '').replace(/\n$/, '').replace(/<\\\/script/gi, '</script');

/* ------------------------------------------------------------------ */
section('B. fidelity of inlined payloads');

function compareInlined(name, blockText, sourcePath) {
  /* The inlined copy must be byte-identical to the file it came from. */
  const want = fs.readFileSync(sourcePath);
  const got = Buffer.from(unescapeBlock(blockText), 'utf8');
  if (!got.equals(want)) {
    fail(name, `decoded ${got.length} bytes, expected ${want.length}`);
    return;
  }
  ok(name, `${want.length} bytes identical`);
}

compareInlined('Unity launcher', loaderBlock.text, path.join(gameDir, 'Build', 'build.loader.js'));
compareInlined('Unity framework', frameworkBlock.text, path.join(gameDir, 'Build', 'build.framework.js'));
compareInlined('runtime', runtimeSource, path.join(repoRoot, 'tools', 'solo-runtime.js'));

const vfs = JSON.parse(vfsBlock.text);
const config = JSON.parse(configBlock.text);
const streamingDir = path.join(gameDir, 'StreamingAssets');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full)); else out.push(full);
  }
  return out;
}

const onDisk = walk(streamingDir);
check('vfs entry count matches StreamingAssets', Object.keys(vfs).length === onDisk.length,
  `${Object.keys(vfs).length} in file, ${onDisk.length} on disk`);

let vfsBad = 0;
for (const file of onDisk) {
  const key = 'StreamingAssets/' + path.relative(streamingDir, file).split(path.sep).join('/');
  const entry = vfs[key];
  if (!entry) { fail('vfs entry ' + key, 'missing'); vfsBad++; continue; }
  const want = fs.readFileSync(file);
  const got = Buffer.from(entry.b, 'base64');
  if (!got.equals(want)) { fail('vfs entry ' + key, `${got.length} vs ${want.length} bytes`); vfsBad++; }
}
check('every StreamingAssets file round-trips byte-for-byte', vfsBad === 0, `${onDisk.length} files`);

const introMatch = /<img src="data:image\/png;base64,([^"]+)"/.exec(html);
if (introMatch) {
  const want = fs.readFileSync(path.join(gameDir, 'assets', 'port-by-camzzz.png'));
  const got = Buffer.from(introMatch[1], 'base64');
  check('intro art round-trips', got.equals(want), `${want.length} bytes`);
} else fail('intro art round-trips', 'no data URI found');

/* The pre-Unity patches are lifted from index.html; make sure nothing was lost. */
const indexHtml = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');
const marker = 'const manifest=';
const preboot = indexHtml.slice(indexHtml.indexOf('>', indexHtml.lastIndexOf('<script>', indexHtml.indexOf(marker))) + 1,
  indexHtml.indexOf(marker)).trim();
check('pre-Unity patches carried over', html.includes(preboot), `${preboot.length} chars`);

/* --inline-all builds embed the chunk parts as base64 blocks; those have to
 * decode back to the exact files too. */
if (config.inlinedChunks) {
  let bad = 0;
  let seen = 0;
  for (const [label, group] of Object.entries(config.inlinedChunks)) {
    for (const entry of group.parts) {
      seen++;
      const block = extractBlock(entry.id, 'text/plain');
      const file = path.join(gameDir, entry.path);
      if (!block || !fs.existsSync(file)) { fail(`inlined chunk ${entry.path}`, 'block or file missing'); bad++; continue; }
      const want = fs.readFileSync(file);
      const got = Buffer.from(block.text.replace(/\s+/g, ''), 'base64');
      if (!got.equals(want)) { fail(`inlined chunk ${entry.path}`, `${got.length} vs ${want.length} bytes`); bad++; }
    }
  }
  check('every inlined chunk part round-trips byte-for-byte', bad === 0, `${seen} parts`);
} else {
  check('chunks are external (default)', config.inlinedChunks === null);
}

/* ------------------------------------------------------------------ */
section('C. runtime behaviour (shipped solo-runtime.js under a DOM shim)');

/* --- minimal DOM/browser shim -------------------------------------- */
class FakeXHR extends EventTarget {
  constructor() {
    super();
    this._readyState = 0; this._status = 0; this._statusText = '';
    this._response = null; this._responseText = ''; this._responseURL = '';
    this._headers = {}; this._method = null; this._url = null; this._async = true;
    this.responseType = '';
    this.nativeOpens = 0; this.nativeSends = 0;
    /* Real XMLHttpRequest exposes on* as event-handler IDL attributes, so that
     * assigning one registers a listener.  A plain EventTarget subclass does not
     * do that on its own, so model it here or dispatchEvent would never reach
     * the handlers the runtime is expected to trigger. */
    for (const type of ['load', 'error', 'progress', 'readystatechange', 'loadend', 'abort', 'timeout']) {
      let handler = null;
      Object.defineProperty(this, 'on' + type, {
        configurable: true,
        get: () => handler,
        set: (fn) => {
          if (handler) this.removeEventListener(type, handler);
          handler = fn;
          if (typeof fn === 'function') this.addEventListener(type, fn);
        }
      });
    }
  }
  get readyState() { return this._readyState; }
  get status() { return this._status; }
  get statusText() { return this._statusText; }
  get response() { return this._response; }
  get responseText() { return this._responseText; }
  get responseURL() { return this._responseURL; }
  open(method, url, async) { this.nativeOpens++; this._method = method; this._url = url; this._async = async !== false; this._readyState = 1; }
  setRequestHeader(k, v) { this._headers[String(k).toLowerCase()] = v; }
  getResponseHeader(k) { return this._headers['__resp_' + String(k).toLowerCase()] ?? null; }
  getAllResponseHeaders() { return ''; }
  overrideMimeType(m) { this._mime = m; }
  send() { this.nativeSends++; this._readyState = 4; this._status = 200; }
  abort() {}
}

const blocks = new Map([
  ['vfs-data', JSON.stringify(vfs)],
  ['build-config', JSON.stringify(config)]
]);

globalThis.__SOLO_NO_AUTOBOOT = true;
globalThis.document = {
  baseURI: 'http://localhost:8000/game/solo.html',
  getElementById: (id) => (blocks.has(id) ? { textContent: blocks.get(id) } : null),
  createElement: () => ({ src: null, onload: null, onerror: null }),
  body: { appendChild() {} }
};
globalThis.location = { href: 'http://localhost:8000/game/solo.html' };
globalThis.XMLHttpRequest = FakeXHR;
if (typeof globalThis.ProgressEvent !== 'function') globalThis.ProgressEvent = globalThis.Event;

/* fetch() must be present for the patch to install; remember the real one. */
const realFetch = globalThis.fetch;
const networkCalls = [];
globalThis.fetch = (url, init) => { networkCalls.push({ url, init }); return realFetch(url, init); };

const require = createRequire(import.meta.url);
const solo = require(path.join(repoRoot, 'tools', 'solo-runtime.js'));

check('runtime exports its API', typeof solo.boot === 'function' && typeof solo.resolveKey === 'function');

/* assets are registered through the same code path boot() uses */
for (const [key, entry] of Object.entries(vfs)) solo.registerAsset(key, solo.b64ToBytes(entry.b), entry.t);
check('virtual file system populated', solo.size === Object.keys(vfs).length, `${solo.size} entries`);
solo.computePageDir();

const page = 'http://localhost:8000/game/';
const cases = [
  ['StreamingAssets/aa/catalog.bin', 'streamingassets/aa/catalog.bin', 'relative'],
  [page + 'StreamingAssets/aa/catalog.bin', 'streamingassets/aa/catalog.bin', 'absolute'],
  [page + 'StreamingAssets/ScreensVideos/Monitor_LW.webm', 'streamingassets/screensvideos/monitor_lw.webm', 'video, mixed case'],
  [page + 'StreamingAssets/aa/settings.json?hash=abc', 'streamingassets/aa/settings.json', 'query string'],
  [page + 'StreamingAssets/aa/StandaloneWindows64/localization-locales_assets_all.bundle',
    'streamingassets/aa/standalonewindows64/localization-locales_assets_all.bundle', 'deep bundle path'],
  ['./StreamingAssets/credits.json', 'streamingassets/credits.json', 'dot-relative'],
  ['blob:http://localhost/abc-123', null, 'blob: passes through'],
  ['data:application/wasm;base64,AAAA', null, 'data: passes through'],
  [page + 'chunks/build.wasm.part001', null, 'chunk part is not a packed asset'],
  [page + 'StreamingAssets/does-not-exist.bin', null, 'unknown asset passes through']
];
for (const [url, expect, label] of cases) {
  const got = solo.resolveKey(url);
  check(`resolveKey ${label}`, got === expect, `${url} -> ${got}`);
}

/* --- byte ranges ---------------------------------------------------- */
const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ranges = [
  [null, [0, 9], 10, false],
  ['bytes=0-3', [0, 3], 4, true],
  ['bytes=4-', [4, 9], 6, true],
  ['bytes=-3', [7, 9], 3, true],
  ['bytes=2-999', [2, 9], 8, true],
  ['bytes=9-9', [9, 9], 1, true]
];
for (const [header, [s, e], len, partial] of ranges) {
  const r = solo.applyRange(bytes, header);
  check(`applyRange ${header}`, r.start === s && r.end === e && r.body.length === len && r.partial === partial,
    `${r.start}-${r.end} len=${r.body.length} partial=${r.partial}`);
}
const unsat = solo.applyRange(bytes, 'bytes=50-60');
check('applyRange unsatisfiable', unsat.unsatisfiable === true && unsat.body.length === 0);

/* --- fetch patch ---------------------------------------------------- */
solo.installFetchPatch();
const catalogKey = 'streamingassets/aa/catalog.bin';
const catalog = Buffer.from(vfs['StreamingAssets/aa/catalog.bin'].b, 'base64');

const r200 = await globalThis.fetch(page + 'StreamingAssets/aa/catalog.bin');
check('fetch serves a packed asset', r200.status === 200, 'status ' + r200.status);
check('fetch body matches source', Buffer.from(await r200.arrayBuffer()).equals(catalog), `${catalog.length} bytes`);
check('fetch advertises range support', r200.headers.get('accept-ranges') === 'bytes');
check('fetch sets content-length', r200.headers.get('content-length') === String(catalog.length));

const r206 = await globalThis.fetch(page + 'StreamingAssets/aa/catalog.bin', { headers: { Range: 'bytes=0-99' } });
check('fetch honours Range', r206.status === 206, 'status ' + r206.status);
check('fetch 206 body', Buffer.from(await r206.arrayBuffer()).equals(catalog.subarray(0, 100)));
check('fetch 206 Content-Range', r206.headers.get('content-range') === `bytes 0-99/${catalog.length}`,
  r206.headers.get('content-range'));

const rReq = await globalThis.fetch(new Request(page + 'StreamingAssets/aa/catalog.bin', { headers: { Range: 'bytes=10-19' } }));
check('fetch honours Range on a Request object', rReq.status === 206 && (await rReq.arrayBuffer()).byteLength === 10);

networkCalls.length = 0;
await globalThis.fetch(page + 'not-packed.txt').catch(() => {});
check('unpacked URLs still hit the network', networkCalls.length === 1, JSON.stringify(networkCalls.map((c) => c.url)));

/* --- XMLHttpRequest patch ------------------------------------------- */
solo.installXhrPatch();

function xhrRoundTrip({ url, range, responseType, async = true, mime }) {
  return new Promise((resolve, reject) => {
    const x = new globalThis.XMLHttpRequest();
    const seen = [];
    x.addEventListener('readystatechange', () => seen.push(x.readyState));
    x.open('GET', url, async);
    if (range) x.setRequestHeader('Range', range);
    if (responseType) x.responseType = responseType;
    if (mime && x.overrideMimeType) x.overrideMimeType(mime);
    x.onload = () => resolve({ x, seen });
    x.onerror = (e) => reject(new Error('xhr error ' + JSON.stringify(e)));
    x.send();
    if (!async) setTimeout(() => resolve({ x, seen }), 0);
  });
}

const video = Buffer.from(vfs['StreamingAssets/ScreensVideos/Monitor_security.mp4'].b, 'base64');
const videoUrl = page + 'StreamingAssets/ScreensVideos/Monitor_security.mp4';

const ab = await xhrRoundTrip({ url: videoUrl, responseType: 'arraybuffer' });
check('XHR delivers a packed asset', ab.x.status === 200 && ab.x.readyState === 4, `status ${ab.x.status}`);
check('XHR arraybuffer body', Buffer.from(ab.x.response).equals(video), `${video.length} bytes`);
check('XHR arraybuffer is a real ArrayBuffer', ab.x.response instanceof ArrayBuffer);
check('XHR did not touch the network', ab.x.nativeSends === 0, `native send calls: ${ab.x.nativeSends}`);
check('XHR fires readyState 2,3,4', [2, 3, 4].every((s) => ab.seen.includes(s)), ab.seen.join('>'));
check('XHR exposes Content-Length', ab.x.getResponseHeader('Content-Length') === String(video.length),
  ab.x.getResponseHeader('Content-Length'));
check('XHR getAllResponseHeaders', /content-type: video\/mp4/i.test(ab.x.getAllResponseHeaders()));

const rg = await xhrRoundTrip({ url: videoUrl, range: 'bytes=100-199', responseType: 'arraybuffer' });
check('XHR honours Range', rg.x.status === 206, 'status ' + rg.x.status);
check('XHR 206 body', Buffer.from(rg.x.response).equals(video.subarray(100, 200)));
check('XHR 206 Content-Range', rg.x.getResponseHeader('Content-Range') === `bytes 100-199/${video.length}`,
  rg.x.getResponseHeader('Content-Range'));

const txt = await xhrRoundTrip({ url: page + 'StreamingAssets/credits.json', responseType: 'text' });
const creditsWant = fs.readFileSync(path.join(streamingDir, 'credits.json'), 'utf8');
check('XHR text response', txt.x.responseText === creditsWant, `${txt.x.responseText.length} chars`);

const js = await xhrRoundTrip({ url: page + 'StreamingAssets/aa/settings.json', responseType: 'json' });
check('XHR json response', js.x.response && typeof js.x.response === 'object');

const bl = await xhrRoundTrip({ url: videoUrl, responseType: 'blob' });
check('XHR blob response', bl.x.response instanceof Blob && bl.x.response.size === video.length);

const sync = await xhrRoundTrip({ url: page + 'StreamingAssets/aa/catalog.hash', responseType: 'arraybuffer', async: false });
const hashWant = fs.readFileSync(path.join(streamingDir, 'aa', 'catalog.hash'));
check('synchronous XHR', sync.x.status === 200 && Buffer.from(sync.x.response).equals(hashWant),
  `${sync.x.response.byteLength} bytes`);

const miss = await new Promise((resolve) => {
  const x = new globalThis.XMLHttpRequest();
  x.open('GET', page + 'StreamingAssets/aa/catalog.bin');
  x.onload = () => resolve({ status: x.status, native: x.nativeSends });
  x.send();
});
check('packed asset never falls back to XHR network path', miss.native === 0 && miss.status === 200);

const passthrough = new globalThis.XMLHttpRequest();
passthrough.open('GET', 'http://example.invalid/thing.bin', true);
check('unpacked XHR still uses the native transport', passthrough.nativeOpens === 1 && passthrough.__vfs === null);

/* --- chunk group loader: inlined path ------------------------------- */
const sampleA = new Uint8Array([9, 8, 7, 6, 5]);
const sampleB = new Uint8Array([4, 3, 2, 1, 0]);
blocks.set('inline-test-001', Buffer.from(sampleA).toString('base64'));
blocks.set('inline-test-002', Buffer.from(sampleB).toString('base64'));
/* Return a stable element per id: the runtime clears a block it has consumed,
 * and that write has to be observable. */
const elements = new Map();
globalThis.document.getElementById = (id) => {
  if (!blocks.has(id)) return null;
  if (!elements.has(id)) elements.set(id, { id, textContent: blocks.get(id) });
  return elements.get(id);
};
solo.registerInlineBlock('chunks/test.part001', 'inline-test-001', 'application/octet-stream');
solo.registerInlineBlock('chunks/test.part002', 'inline-test-002', 'application/octet-stream');

const inlineProgress = [];
const inlineBlob = await solo.loadChunkGroup(
  { label: 'test', type: 'application/octet-stream', parts: ['chunks/test.part001', 'chunks/test.part002'] },
  (done, total, label) => inlineProgress.push(`${label} ${done}/${total}`)
);
check('inlined chunk group assembles every part', inlineBlob.size === sampleA.length + sampleB.length,
  `${inlineBlob.size} bytes`);
check('inlined chunk group concatenates in order',
  Buffer.from(await inlineBlob.arrayBuffer()).equals(Buffer.concat([Buffer.from(sampleA), Buffer.from(sampleB)])));
check('inlined chunk group reports progress per part', inlineProgress.length === 2, inlineProgress.join(', '));
check('inlined chunk parts are released after use', solo.inlineSize === 0);
check('inlined chunk block is emptied in the DOM', elements.get('inline-test-001').textContent === '');

/* --- chunk group loader: HTTP path (the default for this build) ----- */
const httpPart1 = new Uint8Array(4096).fill(0xAA);
const httpPart2 = new Uint8Array(2048).fill(0xBB);
const httpParts = { 'chunks/build.data.part001': httpPart1, 'chunks/build.data.part002': httpPart2 };
const httpLog = [];
const vfsFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  httpLog.push({ url, method: (init && init.method) || 'GET', range: init && init.headers ? init.headers.Range : null });
  const body = httpParts[url];
  if (body) return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  return Promise.resolve(new Response(null, { status: 404 }));
};

const httpProgress = [];
const httpBlob = await solo.loadChunkGroup(
  { label: 'build.data', type: 'application/octet-stream', parts: Object.keys(httpParts) },
  (done, total, label) => httpProgress.push(`${label} ${done}/${total}`)
);
check('http chunk group assembles every part', httpBlob.size === httpPart1.length + httpPart2.length,
  `${httpBlob.size} bytes`);
check('http chunk group concatenates in order',
  Buffer.from(await httpBlob.arrayBuffer()).equals(Buffer.concat([Buffer.from(httpPart1), Buffer.from(httpPart2)])));
check('http chunk group reports progress per part', httpProgress.length === 2, httpProgress.join(', '));
check('http path probes the first part with HEAD',
  httpLog.length === 3 && httpLog[0].method === 'HEAD',
  JSON.stringify(httpLog.map((c) => c.method + ' ' + c.url)));
check('http path fetches each part exactly once',
  httpLog.slice(1).map((c) => c.method + ' ' + c.url).join('|') ===
  'GET chunks/build.data.part001|GET chunks/build.data.part002');

/* A host that answers HEAD with 404 but serves the part on a ranged GET must
 * still be accepted. */
httpLog.length = 0;
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  httpLog.push(method + ' ' + url);
  if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 405 }));
  return Promise.resolve(new Response(httpParts[url], { status: 200 }));
};
const fallbackBlob = await solo.loadChunkGroup(
  { label: 'build.data', type: 'application/octet-stream', parts: ['chunks/build.data.part001'] }
);
check('http probe falls back to a ranged GET', fallbackBlob.size === httpPart1.length &&
  httpLog[0] === 'HEAD chunks/build.data.part001' && httpLog[1] === 'GET chunks/build.data.part001',
  httpLog.join(' -> '));
check('http chunk blob carries the manifest MIME type', httpBlob.type === 'application/octet-stream');

/* --- chunk group loader: local folder picker ------------------------ *
 * Drives the picker the way a user does: click the button, pick a folder,
 * drop a folder, pick the wrong thing. */
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeEl(id, extra) {
  const listeners = {};
  return Object.assign({
    id,
    _listeners: listeners,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fire(t, ev) { for (const fn of (listeners[t] || []).slice()) fn(ev); }
  }, extra || {});
}
/* File objects are Blobs with a name, so they work as Blob parts. */
function namedBlob(name, bytes) { const b = new Blob([bytes]); b.name = name; return b; }
function fileEntry(file) { return { isFile: true, isDirectory: false, file: (ok) => ok(file) }; }
function dirEntry(children) {
  return {
    isFile: false,
    isDirectory: true,
    createReader() {
      let done = false;
      return { readEntries: (ok) => (done ? ok([]) : (done = true, ok(children))) };
    }
  };
}

const docListeners = {};
globalThis.document.addEventListener = (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); };

function installPickerPanel() {
  const input = fakeEl('file-input', { files: [], clicks: 0, click() { this.clicks++; } });
  const status = fakeEl('chunk-picker-status', { textContent: '' });
  const panel = fakeEl('chunk-picker', {
    hidden: true,
    querySelector(sel) {
      if (sel === 'input[type=file]') return input;
      if (sel === '#chunk-picker-status') return status;
      return null;
    }
  });
  globalThis.document.getElementById = (id) => {
    if (id === 'chunk-picker') return panel;
    return blocks.has(id) ? { textContent: blocks.get(id) } : null;
  };
  return { panel, input, status };
}

/* Nothing on disk: every probe 404s, so the picker is the only way forward. */
globalThis.fetch = () => Promise.resolve(new Response(null, { status: 404 }));

const pickData = ['chunks/build.data.part001', 'chunks/build.data.part002', 'chunks/build.data.part003'];
const pickWasm = ['chunks/build.wasm.part001', 'chunks/build.wasm.part002'];
const dataGroup = { label: 'build.data', type: 'application/octet-stream', parts: pickData };
const wasmGroup = { label: 'build.wasm', type: 'application/wasm', parts: pickWasm };
const pickedBytes = {
  'build.data.part001': Buffer.from([0xa1, 0xa2]),
  'build.data.part002': Buffer.from([0xb1]),
  'build.data.part003': Buffer.from([0xc1, 0xc2, 0xc3]),
  'build.wasm.part001': Buffer.from([0xd1, 0xd2]),
  'build.wasm.part002': Buffer.from([0xe1])
};
const pickedFiles = Object.entries(pickedBytes).map(([name, bytes]) => namedBlob(name, bytes));

/* A: the button has to actually open the dialog */
{
  solo._resetLocalSelection();
  const ui = installPickerPanel();
  let settled = null;
  solo.loadChunkGroup(dataGroup).then(() => { settled = 'resolved'; }, (e) => { settled = e.message; });
  await tick();
  check('picker panel is shown when no chunks are reachable', ui.panel.hidden === false);
  check('picker explains what to do', /chunks/i.test(ui.status.textContent), ui.status.textContent.slice(0, 48) + '…');
  /* The <button> sits inside a .card, so its click reaches the panel by bubbling. */
  ui.panel.fire('click', { target: { tagName: 'BUTTON' } });
  check('clicking the button opens the file dialog', ui.input.clicks === 1, 'input.click() calls: ' + ui.input.clicks);
  ui.panel.fire('click', { target: ui.panel });
  check('clicking the panel background also opens it', ui.input.clicks === 2, 'input.click() calls: ' + ui.input.clicks);
  ui.panel.fire('click', { target: ui.input });
  check('clicking the input itself does not recurse', ui.input.clicks === 2, 'input.click() calls: ' + ui.input.clicks);

  /* B: an unrecognised selection is reported, and does not resolve */
  ui.input.files = [namedBlob('readme.txt', Buffer.from('hi')), namedBlob('build.data', Buffer.from('x'))];
  ui.input.fire('change');
  await tick();
  check('unrecognised selection is reported and rejected nowhere',
    settled === null && /Nothing recognised/.test(ui.status.textContent),
    'settled=' + settled + ' | ' + ui.status.textContent.slice(0, 40) + '…');
  check('picker stays visible after a bad pick', ui.panel.hidden === false);

  /* C: a short pick is reported, keeps the picker open, and can be retried */
  ui.input.files = [pickedFiles[0]];
  ui.input.fire('change');
  await tick();
  check('short selection is reported with a count and not accepted',
    settled === null && ui.panel.hidden === false &&
    /found 1 of 3 build\.data\.partNNN/i.test(ui.status.textContent),
    'settled=' + settled + ' | ' + ui.status.textContent);
  check('shortfall helper names the missing group',
    solo.shortfall([pickedFiles[0]], 'data', 3) === 'found 1 of 3 build.data.partNNN' &&
    solo.shortfall([pickedFiles[0]], 'data', 1) === null);
}

/* D: one full pick serves both groups, in part order, ignoring other files */
{
  solo._resetLocalSelection();
  const ui = installPickerPanel();
  const dataPromise = solo.loadChunkGroup(dataGroup);
  await tick();
  /* shuffled, with junk mixed in */
  ui.input.files = [pickedFiles[4], namedBlob('credits.json', Buffer.from('{}')), pickedFiles[2],
    pickedFiles[0], pickedFiles[3], pickedFiles[1]];
  ui.input.fire('change');
  const dataBlob = await dataPromise;
  check('full pick closes the picker', ui.panel.hidden === true);
  check('data group built from the picked files',
    Buffer.from(await dataBlob.arrayBuffer()).equals(
      Buffer.concat([pickedBytes['build.data.part001'], pickedBytes['build.data.part002'], pickedBytes['build.data.part003']])),
    dataBlob.size + ' bytes in part order');
  check('data blob ignores non-chunk files', dataBlob.size === 6, dataBlob.size + ' bytes');

  /* the wasm group must reuse the same pick, not ask again */
  const clicksBefore = ui.input.clicks;
  const wasmBlob = await solo.loadChunkGroup(wasmGroup);
  check('second group reuses the same pick', ui.input.clicks === clicksBefore, 'no extra dialog');
  check('wasm group built from the same pick',
    Buffer.from(await wasmBlob.arrayBuffer()).equals(
      Buffer.concat([pickedBytes['build.wasm.part001'], pickedBytes['build.wasm.part002']])),
    wasmBlob.size + ' bytes');
  check('wasm blob carries the wasm MIME type', wasmBlob.type === 'application/wasm');
}

/* E: dropping the folder (a directory, which never appears in dataTransfer.files) */
{
  solo._resetLocalSelection();
  const ui = installPickerPanel();
  const dataPromise = solo.loadChunkGroup(dataGroup);
  await tick();
  const dt = {
    files: [],
    items: [{ webkitGetAsEntry: () => dirEntry(pickedFiles.map((f) => fileEntry(f))) }]
  };
  ui.panel.fire('drop', { preventDefault() {}, dataTransfer: dt });
  const blob = await dataPromise;
  check('dropped folder is walked and used', blob.size === 6, blob.size + ' bytes');
  check('dropped folder closes the picker', ui.panel.hidden === true);
}

/* F: a drop that misses the panel must not navigate the page away */
check('document guards against stray drops', (docListeners.drop || []).length > 0 &&
  (docListeners.dragover || []).length > 0);
let navigated = false;
for (const fn of docListeners.drop || []) fn({ preventDefault() { navigated = true; } });
check('stray drop is prevented', navigated);

globalThis.fetch = vfsFetch;


/* ------------------------------------------------------------------ */
section('D. chunk manifest vs files on disk');

const chunksDir = path.join(gameDir, 'chunks');
for (const [label, group] of Object.entries(config.chunks)) {
  let total = 0;
  let missing = 0;
  for (const rel of group.parts) {
    const p = path.join(gameDir, rel);
    if (!fs.existsSync(p)) { missing++; continue; }
    total += fs.statSync(p).size;
  }
  check(`build.${label} manifest resolves on disk`, missing === 0,
    `${group.parts.length} parts, ${missing} missing, ${(total / 1048576).toFixed(1)} MiB`);
  if (label === 'wasm') {
    const declared = /wasmFileSize:\s*(\d+)/.exec(fs.readFileSync(path.join(gameDir, 'Build', 'build.loader.js'), 'utf8'));
    const want = declared ? Number(declared[1]) : -1;
    if (allowSizeMismatch) {
      console.log(`  skip wasm parts sum to the size the launcher declares  (${total} on disk vs ${want} declared, synthetic build)`);
    } else {
      check('wasm parts sum to the size the launcher declares', total === want,
        `${total} bytes on disk vs ${want} declared`);
    }
  }
}
check('manifest order is sorted by part number',
  config.chunks.data.parts.every((p, i, a) => i === 0 || a[i - 1] < p) &&
  config.chunks.wasm.parts.every((p, i, a) => i === 0 || a[i - 1] < p));

/* ------------------------------------------------------------------ */
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('single-file build verified');
