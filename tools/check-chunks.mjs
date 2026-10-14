#!/usr/bin/env node
/*
 * check-chunks.mjs
 *
 * Assembles the REAL chunk parts through the shipped runtime's loadChunkGroup,
 * over real HTTP, and compares the result byte-for-byte with a direct
 * concatenation of the same files.  Then compiles the wasm to prove the module
 * the browser should receive is valid.
 *
 * This is the check that decides whether a truncated module came from the
 * assembly code or from the files themselves.
 *
 * Usage: node tools/check-chunks.mjs [game-dir]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameDir = path.resolve(process.argv[2] || path.join(repoRoot, 'game'));

let failures = 0;
const ok = (n, d) => console.log(`  ok   ${n}${d ? '  ' + d : ''}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));

const config = (() => {
  const html = fs.readFileSync(path.join(gameDir, 'solo.html'), 'utf8');
  const open = '<script type="application/json" id="build-config">';
  const at = html.indexOf(open);
  return JSON.parse(html.slice(at + open.length, html.indexOf('</script>', at)));
})();

/* ---- 1. what is actually on disk ---- */
console.log('parts on disk');
const disk = {};
for (const [label, group] of Object.entries(config.chunks)) {
  let total = 0;
  const sizes = [];
  for (const rel of group.parts) {
    const st = fs.statSync(path.join(gameDir, rel));
    total += st.size;
    sizes.push(st.size);
  }
  disk[label] = { total, sizes };
  console.log(`  build.${label}: ${group.parts.length} parts, ${total} bytes`);
  console.log(`    first=${sizes[0]} last=${sizes[sizes.length - 1]}`);
}

const loaderSrc = fs.readFileSync(path.join(gameDir, 'Build', 'build.loader.js'), 'utf8');
const declaredWasm = Number(/wasmFileSize:\s*(\d+)/.exec(loaderSrc)[1]);
check('build.wasm on disk matches the launcher declaration',
  disk.wasm.total === declaredWasm, `${disk.wasm.total} vs ${declaredWasm}`);

/* ---- 2. serve the real parts and assemble them with the shipped runtime ---- */
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(gameDir, rel);
  if (!file.startsWith(gameDir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(file).size;
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(size), 'accept-ranges': 'bytes' };
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

globalThis.document = { baseURI: origin + '/solo.html', getElementById: () => null, addEventListener() {} };
globalThis.location = { href: origin + '/solo.html' };
const absoluteFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  absoluteFetch(typeof input === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(input) ? origin + '/' + input : input, init);

const require = createRequire(import.meta.url);
const solo = require(path.join(repoRoot, 'tools', 'solo-runtime.js'));
solo.computePageDir();

console.log('\nassembling the real parts through loadChunkGroup (over HTTP)');
const assembled = {};
for (const [label, group] of Object.entries(config.chunks)) {
  const t0 = Date.now();
  const blob = await solo.loadChunkGroup(group, () => {});
  assembled[label] = blob;
  check(`build.${label} assembled size`, blob.size === disk[label].total,
    `${blob.size} bytes (expected ${disk[label].total}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---- 3. byte-for-byte against a direct concatenation ---- *
 * Compared one part at a time: holding three copies of an 857 MiB file does not
 * fit in the memory this sandbox has. */
console.log('\ncomparing against a direct concatenation (part by part)');
for (const [label, group] of Object.entries(config.chunks)) {
  const blob = assembled[label];
  let offset = 0;
  let mismatch = -1;
  for (const rel of group.parts) {
    const want = fs.readFileSync(path.join(gameDir, rel));
    const got = Buffer.from(await blob.slice(offset, offset + want.length).arrayBuffer());
    if (got.length !== want.length || !got.equals(want)) { mismatch = offset; break; }
    offset += want.length;
  }
  check(`build.${label} is byte-identical to cat of its parts`, mismatch === -1 && offset === blob.size,
    mismatch === -1 ? `${offset} bytes` : `first difference at byte ${mismatch}`);
  if (label === 'data') assembled.data = null; // free 857 MiB before the compile
}

/* ---- 4. does the module the browser receives actually compile? ---- */
console.log('\ncompiling the assembled wasm');
const wasmBlob = assembled.wasm;
const wasmBytes = Buffer.from(await wasmBlob.slice(0, 64).arrayBuffer());
check('wasm magic + version', wasmBytes.readUInt32LE(0) === 0x6d736100 && wasmBytes.readUInt32LE(4) === 1);
try {
  const t0 = Date.now();
  const mod = await WebAssembly.compile(await wasmBlob.arrayBuffer());
  check('WebAssembly.compile succeeds', true,
    `${(wasmBlob.size / 1048576).toFixed(1)} MiB compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
    `${WebAssembly.Module.exports(mod).length} exports`);
} catch (e) {
  check('WebAssembly.compile succeeds', false, e.message);
}

/* ---- 5. the same, but with the tail cut off as reported ---- */
console.log('\nreproducing the reported error');
try {
  await WebAssembly.compile(await wasmBlob.slice(0, 336582907).arrayBuffer());
  bad('a 336,582,907-byte copy reproduces the CompileError', 'it compiled');
} catch (e) {
  const matches = /extends past end of the module/.test(e.message) && e.message.includes('55728641');
  check('a 336,582,907-byte copy reproduces the CompileError', matches, e.message);
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall chunk checks passed');
process.exit(failures ? 1 : 0);
