#!/usr/bin/env node
/*
 * e2e-boot-test.mjs
 *
 * Boots the real generated single-file document.
 *
 * It serves a temporary directory over HTTP that contains the actual
 * game/solo.html plus tiny stand-in chunk parts named exactly as the manifest
 * expects, then runs the shipped runtime's boot() against it: the virtual file
 * system is built from the real vfs-data block, the launcher and framework are
 * turned into blob: URLs, the chunk parts are pulled over real HTTP and
 * assembled, and createUnityInstance is handed the resulting config.
 *
 * The two Unity binaries are the only thing faked - everything else is the
 * generated artifact.
 *
 * Usage: node tools/e2e-boot-test.mjs [path/to/solo.html]
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.resolve(process.argv[2] || path.join(repoRoot, 'game', 'solo.html'));
const gameDir = path.dirname(htmlPath);

let failures = 0;
let checks = 0;
const ok = (n, d) => { checks++; console.log(`  ok   ${n}${d ? '  ' + d : ''}`); };
const fail = (n, d) => { failures++; checks++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : fail(n, d));

/* ---------------- stage the served directory ---------------- */

const html = fs.readFileSync(htmlPath, 'utf8');
const configBlock = (() => {
  const open = '<script type="application/json" id="build-config">';
  const s = html.indexOf(open);
  return html.slice(s + open.length, html.indexOf('</script>', s));
})();
const vfsBlock = (() => {
  const open = '<script type="application/json" id="vfs-data">';
  const s = html.indexOf(open);
  return html.slice(s + open.length, html.indexOf('</script>', s));
})();
const config = JSON.parse(configBlock);

/* Extract a raw block exactly as a browser's textContent would return it, with
 * only the </script escaping reversed. */
function rawBlock(id, type) {
  const open = `<script type="${type}" id="${id}">`;
  const at = html.indexOf(open);
  if (at === -1) return null;
  const bodyStart = at + open.length;
  return html.slice(bodyStart, html.indexOf('</script>', bodyStart))
    .replace(/<\\\/script/gi, '</script');
}
const loaderBlockText = rawBlock('unity-loader-src', 'text/plain');
const frameworkBlockText = rawBlock('unity-framework-src', 'text/plain');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-e2e-'));
fs.writeFileSync(path.join(root, 'solo.html'), html);
fs.mkdirSync(path.join(root, 'chunks'), { recursive: true });

/*
 * Two modes, both exercised by the same test:
 *   - chunks external  -> write tiny stand-in parts and let boot() fetch them
 *   - chunks inlined   -> the parts live in the document; boot() must not ask
 *                         the server for a single one of them
 */
const inlinedChunks = !!config.inlinedChunks;
const partBytes = new Map();
let expectedData = 0;
let expectedWasm = 0;
for (const [label, group] of Object.entries(config.chunks)) {
  group.parts.forEach((rel, i) => {
    let payload;
    if (inlinedChunks) {
      const entry = config.inlinedChunks[label].parts.find((p) => p.path === rel);
      if (!entry) throw new Error('inlined chunk manifest entry missing for ' + rel);
      payload = Buffer.from(rawBlock(entry.id, 'text/plain').replace(/\s+/g, ''), 'base64');
    } else {
      /* Distinct bytes per part so a wrong ordering shows up. */
      payload = Buffer.alloc(64 + i, (label === 'data' ? 0xd0 : 0xc0) + (i % 16));
      fs.writeFileSync(path.join(root, rel), payload);
    }
    partBytes.set(rel, payload);
    if (label === 'data') expectedData += payload.length; else expectedWasm += payload.length;
  });
}
console.log(`mode: chunks ${inlinedChunks ? 'inlined in the document' : 'fetched over HTTP'}`);

/* ---------------- serve it ---------------- */

const MIME_BY_EXT = { '.html': 'text/html', '.bin': 'application/octet-stream' };
const chunkRequests = [];
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  if (rel.startsWith('chunks/')) chunkRequests.push(req.method + ' ' + rel);
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  const body = fs.readFileSync(file);
  const headers = {
    'content-type': MIME_BY_EXT[path.extname(file)] || 'application/octet-stream',
    'content-length': String(body.length),
    'accept-ranges': 'bytes'
  };
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  res.writeHead(200, headers); res.end(body);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`booting ${path.relative(repoRoot, htmlPath)} against ${origin}`);

/* ---------------- browser shim ---------------- */

const statusLog = [];
const progressLog = [];
const elements = new Map();
function el(id, build) {
  if (!elements.has(id)) elements.set(id, build(id));
  return elements.get(id);
}
el('status', (id) => { let t = ''; return { id, set textContent(v) { statusLog.push(v); t = v; }, get textContent() { return t; } }; });
el('progress', (id) => { let v = 0; return { id, set value(x) { progressLog.push(x); v = x; }, get value() { return v; } }; });
el('unity-canvas', (id) => ({ id, focus() { this.focused = true; } }));
el('loading', (id) => ({ id, remove() { this.removed = true; } }));
el('error', (id) => ({ id, hidden: true, textContent: '' }));
el('vfs-data', (id) => ({ id, textContent: vfsBlock }));
el('build-config', (id) => ({ id, textContent: configBlock }));
el('unity-loader-src', (id) => ({ id, textContent: loaderBlockText }));
el('unity-framework-src', (id) => ({ id, textContent: frameworkBlockText }));
/* An --inline-all build keeps the chunk parts in the document as base64 blocks
 * that the runtime reads (and clears) by element id. */
if (inlinedChunks) {
  for (const group of Object.values(config.inlinedChunks)) {
    for (const entry of group.parts) {
      el(entry.id, (id) => ({ id, textContent: rawBlock(entry.id, 'text/plain') }));
    }
  }
}

const loaderScriptUrls = [];
globalThis.document = {
  baseURI: origin + '/solo.html',
  getElementById: (id) => (elements.has(id) ? elements.get(id) : null),
  createElement: (tag) => {
    const node = { tagName: tag, src: null, onload: null, onerror: null };
    return node;
  },
  body: {
    appendChild(node) {
      loaderScriptUrls.push(node.src);
      /* Act as the browser would: the script executes, then load fires. */
      setTimeout(() => { if (node.onload) node.onload(); }, 0);
      return node;
    }
  }
};
globalThis.location = { href: origin + '/solo.html' };
globalThis.console = console;

let capturedConfig = null;
let capturedSizes = null;
globalThis.createUnityInstance = async (canvas, unityConfig, onProgress) => {
  capturedConfig = unityConfig;
  onProgress(0.5);
  onProgress(1);
  /* boot() revokes the object URLs as soon as we resolve, so read them now. */
  const [framework, data, code] = await Promise.all([
    fetch(unityConfig.frameworkUrl).then((r) => r.arrayBuffer()),
    fetch(unityConfig.dataUrl).then((r) => r.arrayBuffer()),
    fetch(unityConfig.codeUrl).then((r) => r.arrayBuffer())
  ]);
  capturedSizes = {
    framework: new Uint8Array(framework),
    data: new Uint8Array(data),
    code: new Uint8Array(code)
  };
  return { Quit: () => {}, SetFullscreen: () => {}, canvas };
};

/* Node's fetch needs absolute URLs; a browser resolves the relative chunk paths
 * against the page.  Do the same here so the runtime sees the URLs it expects. */
const absoluteFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    input = origin + '/' + input.replace(/^\/+/, '');
  }
  return absoluteFetch(input, init);
};

globalThis.__SOLO_NO_AUTOBOOT = true;
const require = createRequire(import.meta.url);
const solo = require(path.join(repoRoot, 'tools', 'solo-runtime.js'));

/* ---------------- run the real boot ---------------- */

let bootError = null;
try {
  await solo.boot();
} catch (e) {
  bootError = e;
}
check('boot() completes', bootError === null, bootError ? bootError.stack : '');

if (bootError) {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

console.log('\nboot wiring');
check('launcher was loaded from an inlined blob script',
  loaderScriptUrls.length === 1 && loaderScriptUrls[0].startsWith('blob:'), String(loaderScriptUrls[0]));
check('frameworkUrl is a blob URL', String(capturedConfig.frameworkUrl).startsWith('blob:'));
check('dataUrl is a blob URL', String(capturedConfig.dataUrl).startsWith('blob:'));
check('codeUrl is a blob URL', String(capturedConfig.codeUrl).startsWith('blob:'));
check('streamingAssetsUrl preserved', capturedConfig.streamingAssetsUrl === 'StreamingAssets');
check('product metadata preserved', capturedConfig.companyName === 'CamzzzWebPorts' &&
  capturedConfig.productName === 'Gamble With Your Friends - Solo Web Port');
check('createUnityInstance received a progress callback',
  progressLog.includes(0.5) && progressLog.includes(1), progressLog.join(','));

console.log('\npayloads handed to Unity');
const wantFramework = fs.readFileSync(path.join(gameDir, 'Build', 'build.framework.js'));
check('framework blob is the real framework',
  Buffer.from(capturedSizes.framework).equals(wantFramework), `${capturedSizes.framework.length} bytes`);
check('data blob is every part in manifest order',
  capturedSizes.data.length === expectedData &&
  Buffer.from(capturedSizes.data).equals(Buffer.concat(config.chunks.data.parts.map((p) => partBytes.get(p)))),
  `${capturedSizes.data.length} bytes from ${config.chunks.data.parts.length} parts`);
check('code blob is every part in manifest order',
  capturedSizes.code.length === expectedWasm &&
  Buffer.from(capturedSizes.code).equals(Buffer.concat(config.chunks.wasm.parts.map((p) => partBytes.get(p)))),
  `${capturedSizes.code.length} bytes from ${config.chunks.wasm.parts.length} parts`);

console.log('\npacked assets served from the document');
const assetChecks = [
  ['StreamingAssets/aa/catalog.bin', path.join(gameDir, 'StreamingAssets', 'aa', 'catalog.bin')],
  ['StreamingAssets/aa/settings.json', path.join(gameDir, 'StreamingAssets', 'aa', 'settings.json')],
  ['StreamingAssets/ScreensVideos/Monitor_security.webm',
    path.join(gameDir, 'StreamingAssets', 'ScreensVideos', 'Monitor_security.webm')],
  ['StreamingAssets/aa/StandaloneWindows64/localization-locales_assets_all.bundle',
    path.join(gameDir, 'StreamingAssets', 'aa', 'StandaloneWindows64', 'localization-locales_assets_all.bundle')]
];
for (const [url, file] of assetChecks) {
  const want = fs.readFileSync(file);
  const got = Buffer.from(await fetch(origin + '/' + url).then((r) => r.arrayBuffer()));
  check(url, got.equals(want), `${want.length} bytes`);
}
const ranged = await fetch(origin + '/StreamingAssets/aa/catalog.bin', { headers: { Range: 'bytes=0-9' } });
const catalogWant = fs.readFileSync(assetChecks[0][1]);
check('ranged request into a packed asset', ranged.status === 206 &&
  Buffer.from(await ranged.arrayBuffer()).equals(catalogWant.subarray(0, 10)), 'status ' + ranged.status);

const served = await fetch(origin + '/solo.html');
check('the document itself is still served normally', served.status === 200);

console.log('\nui state');
check('loading overlay removed', elements.get('loading').removed === true);
check('canvas focused', elements.get('unity-canvas').focused === true);
check('unityInstance published', !!globalThis.unityInstance);
check('status text reported progress',
  statusLog.some((s) => /build\.data/.test(s)) && statusLog.some((s) => /build\.wasm/.test(s)) &&
  statusLog.includes('Starting game…'), statusLog.slice(-3).join(' | '));
check('no error panel shown', elements.get('error').hidden === true);
if (inlinedChunks) {
  check('inlined build never requests a chunk over HTTP', chunkRequests.length === 0,
    chunkRequests.length ? chunkRequests.slice(0, 4).join(', ') : 'no chunk requests');
} else {
  check('external build fetches every chunk part over HTTP',
    chunkRequests.filter((r) => r.startsWith('GET')).length ===
    config.chunks.data.parts.length + config.chunks.wasm.parts.length,
    `${chunkRequests.filter((r) => r.startsWith('GET')).length} GETs`);
}

server.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('end-to-end boot verified');
