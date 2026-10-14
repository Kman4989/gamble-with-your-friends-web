#!/usr/bin/env node
/*
 * make-single-file.mjs
 *
 * Folds the web port into one runnable HTML document.
 *
 * Inlined by default (everything that is small enough to be inlined):
 *   game/index.html          markup, styles and the pre-Unity browser patches
 *   game/Build/build.loader.js      Unity launcher
 *   game/Build/build.framework.js   Unity engine framework (~1.1 MB)
 *   game/StreamingAssets/**         videos, addressables catalog, localisation bundles
 *   game/assets/port-by-camzzz.png  intro art (as a data: URI)
 *
 * Not inlined by default:
 *   game/chunks/build.data.part001..050   ~857 MiB
 *   game/chunks/build.wasm.part001..019   ~322 MiB
 * Those stay as separate files because a document holding them would be ~1.65 GB
 * of base64.  Use --inline-all if you really want one file and can live with it.
 *
 * Usage:
 *   node tools/make-single-file.mjs                      -> game/solo.html
 *   node tools/make-single-file.mjs --out dist/solo.html
 *   node tools/make-single-file.mjs --inline-all         -> truly single ~1.65 GB file
 *   node tools/make-single-file.mjs --no-framework       -> keep framework external
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    source: path.join(repoRoot, 'game'),
    out: null,
    inlineAll: false,
    inlineFramework: true,
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--source' || a === '-s') opts.source = path.resolve(argv[++i]);
    else if (a === '--inline-all') opts.inlineAll = true;
    else if (a === '--no-framework') opts.inlineFramework = false;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else throw new Error('Unknown option: ' + a);
  }
  if (!opts.out) opts.out = path.join(opts.source, 'solo.html');
  return opts;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(full);
  }
  return out;
}

const MIME = [
  [/\.webm$/i, 'video/webm'],
  [/\.mp4$/i, 'video/mp4'],
  [/\.json$/i, 'application/json'],
  [/\.png$/i, 'image/png'],
  [/\.hash$/i, 'text/plain'],
  [/\.bin$/i, 'application/octet-stream'],
  [/\.bundle$/i, 'application/octet-stream'],
  [/\.wasm$/i, 'application/wasm'],
  [/\.txt$/i, 'text/plain']
];
const mimeFor = (p) => (MIME.find(([re]) => re.test(p)) || [null, 'application/octet-stream'])[1];

/*
 * A <script> element ends at the first "</script", so that sequence has to be
 * broken up.  "<\/script" is byte-identical to "</script" once the JS parser
 * reads it (in a string, a template literal or a regex), so the embedded source
 * keeps its exact meaning.
 */
function escapeForScriptBlock(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

/* "<" is a valid JSON escape target, so this keeps the payload inert for the
 * HTML parser without changing what JSON.parse produces. */
function escapeJsonForHtml(text) {
  return text.replace(/</g, '\\u003c');
}

function listChunkParts(chunksDir, label) {
  if (!fs.existsSync(chunksDir)) return [];
  return fs.readdirSync(chunksDir)
    .filter((n) => n.startsWith(`build.${label}.part`))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => `chunks/${n}`);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*|\s*\*\/?/gm, ''));
    return;
  }
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  const src = opts.source;
  const indexHtmlPath = path.join(src, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) throw new Error(`No index.html under ${src}`);

  /* ---- 1. markup + the pre-Unity browser patches, lifted from index.html ---- */
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const marker = 'const manifest=';
  const markerAt = indexHtml.indexOf(marker);
  if (markerAt === -1) throw new Error('Could not find the "const manifest=" marker in index.html.');
  const scriptStart = indexHtml.lastIndexOf('<script>', markerAt);
  const preboot = indexHtml.slice(indexHtml.indexOf('>', scriptStart) + 1, markerAt).trim();
  if (!preboot.includes('AudioNode')) throw new Error('Extracted preboot block looks wrong.');

  /* ---- 2. StreamingAssets + intro art -> virtual file system ---- */
  const vfs = {};
  const streamingDir = path.join(src, 'StreamingAssets');
  let vfsBytes = 0;
  for (const file of walk(streamingDir)) {
    const rel = path.relative(streamingDir, file).split(path.sep).join('/');
    const key = 'StreamingAssets/' + rel;
    const buf = fs.readFileSync(file);
    vfsBytes += buf.length;
    vfs[key] = { b: buf.toString('base64'), t: mimeFor(file) };
  }
  log(`packed ${Object.keys(vfs).length} StreamingAssets files (${human(vfsBytes)})`);

  const introPath = path.join(src, 'assets', 'port-by-camzzz.png');
  const introDataUri = fs.existsSync(introPath)
    ? `data:image/png;base64,${fs.readFileSync(introPath).toString('base64')}`
    : '';
  if (introDataUri) log(`packed intro art (${human(fs.statSync(introPath).size)})`);

  /* ---- 3. Unity launcher + framework ---- */
  const loaderPath = path.join(src, 'Build', 'build.loader.js');
  const frameworkPath = path.join(src, 'Build', 'build.framework.js');
  const loaderSrc = fs.readFileSync(loaderPath, 'utf8');
  const frameworkSrc = opts.inlineFramework ? fs.readFileSync(frameworkPath, 'utf8') : null;
  log(`packed Unity launcher (${human(loaderSrc.length)})`);
  if (frameworkSrc) log(`packed Unity framework (${human(frameworkSrc.length)})`);

  /* ---- 4. chunk manifest ---- */
  const chunksDir = path.join(src, 'chunks');
  const dataParts = listChunkParts(chunksDir, 'data');
  const wasmParts = listChunkParts(chunksDir, 'wasm');
  if (dataParts.length === 0 || wasmParts.length === 0) {
    throw new Error(`Expected build.data.part* and build.wasm.part* under ${chunksDir}`);
  }
  let chunkBytes = 0;
  for (const p of [...dataParts, ...wasmParts]) chunkBytes += fs.statSync(path.join(src, p)).size;
  log(`chunk parts: ${dataParts.length} data + ${wasmParts.length} wasm (${human(chunkBytes)})`);

  const buildConfig = {
    chunks: {
      data: { label: 'build.data', type: 'application/octet-stream', parts: dataParts },
      wasm: { label: 'build.wasm', type: 'application/wasm', parts: wasmParts }
    },
    frameworkUrl: opts.inlineFramework ? null : 'Build/build.framework.js',
    inlinedChunks: null,
    generated: {
      utc: new Date().toISOString(),
      loaderSha256: sha256(loaderPath),
      frameworkSha256: opts.inlineFramework ? sha256(frameworkPath) : null,
      dataParts: dataParts.length,
      wasmParts: wasmParts.length,
      inlineAll: opts.inlineAll
    }
  };

  /* ---- 5. optional: inline the 1.2 GB of chunks too ---- */
  const inlineBlocks = [];
  if (opts.inlineAll) {
    console.warn(`WARNING: --inline-all will embed ${human(chunkBytes)} of binaries as ~${human(Math.ceil(chunkBytes / 3) * 4)} of base64.`);
    console.warn('WARNING: the resulting document will very likely exhaust browser memory. It is not recommended.');
    const inlined = {};
    for (const [label, parts] of [['data', dataParts], ['wasm', wasmParts]]) {
      inlined[label] = {
        type: label === 'data' ? 'application/octet-stream' : 'application/wasm',
        parts: parts.map((rel, i) => {
          const id = `inline-${label}-${String(i + 1).padStart(3, '0')}`;
          const bytes = fs.readFileSync(path.join(src, rel));
          inlineBlocks.push({ id, base64: bytes.toString('base64') });
          return { path: rel, id };
        })
      };
    }
    buildConfig.inlinedChunks = inlined;
  }

  /* ---- 6. runtime ---- */
  const runtimeSrc = fs.readFileSync(path.join(repoRoot, 'tools', 'solo-runtime.js'), 'utf8');

  /* ---- 7. assemble ---- */
  const parts = [];
  parts.push(`<!doctype html>
<!--
  Gamble With Your Friends - Solo, single-file build.
  Generated by tools/make-single-file.mjs on ${buildConfig.generated.utc} from commit-tracked sources.

  Packed inside this document: Unity launcher, Unity framework, ${Object.keys(vfs).length} StreamingAssets
  files and the intro art.  The two Unity binaries (${human(chunkBytes)}) are ${opts.inlineAll ? 'also inlined' : `loaded from the chunks/ folder next to this file, or picked from disk`}.

  loader sha256    ${buildConfig.generated.loaderSha256}
  framework sha256 ${buildConfig.generated.frameworkSha256}
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gamble With Your Friends — Solo (single file)</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#08070b;color:#fff;font:16px system-ui,sans-serif}
#unity-canvas{display:block;position:absolute;width:min(100vw,177.7778vh);height:min(100vh,56.25vw);left:50%;top:50%;transform:translate(-50%,-50%);outline:none}
#loading{position:fixed;inset:0;display:grid;place-content:center;text-align:center;gap:18px;background:#08070b}
#loading h1{font-size:clamp(22px,4vw,36px);margin:0}#loading p{margin:0;color:#c7c1d2}
progress{width:min(340px,80vw);height:10px;accent-color:#b600ff;justify-self:center}
#port-intro{position:fixed;inset:0;z-index:10;background:#000;display:grid;place-items:center}
#port-intro img{width:100%;height:100%;object-fit:contain;position:absolute}
#error{max-width:650px;padding:20px;white-space:pre-wrap;color:#ffb8c6}
#chunk-picker{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:#0b0912;padding:24px}
#chunk-picker[hidden]{display:none}
#chunk-picker .card{max-width:560px;text-align:center;display:grid;gap:14px;background:#151122;padding:28px;border-radius:14px;border:1px solid #2c2440}
#chunk-picker h2{margin:0;font-size:22px}
#chunk-picker p{margin:0;color:#c7c1d2;line-height:1.5}
#chunk-picker button{font:inherit;padding:12px 18px;border-radius:10px;border:0;background:#b600ff;color:#fff;cursor:pointer}
#chunk-picker button:hover{background:#c93cff}
#chunk-picker-status{min-height:1.2em;color:#9d94b3;font-size:14px}
#chunk-picker input[type=file]{position:absolute;width:1px;height:1px;opacity:0}
</style>
</head>
<body>
<canvas id="unity-canvas" tabindex="0" aria-label="Gamble With Your Friends solo game"></canvas>
<div id="loading"><h1>Gamble With Your Friends</h1><p id="status">Loading solo game…</p><progress id="progress" max="1" value="0"></progress><div id="error" hidden></div></div>
<div id="port-intro" aria-label="Port by camzzz">${introDataUri ? `<img src="${introDataUri}" alt="Port by camzzz">` : ''}</div>
<div id="chunk-picker" hidden>
  <div class="card">
    <h2>Load the game data</h2>
    <p>This file already contains the launcher, the engine and every game asset. The only things left are the two large Unity binaries, which are too big to embed.</p>
    <p>Choose the <code>chunks</code> folder that shipped next to this file — or drop it here.</p>
    <button type="button">Choose the chunks folder</button>
    <input type="file" webkitdirectory directory multiple>
    <p id="chunk-picker-status"></p>
  </div>
</div>
<script>
/* Pre-Unity browser patches, lifted verbatim from game/index.html. */
${escapeForScriptBlock(preboot)}
</script>
<script type="text/plain" id="unity-loader-src">
${escapeForScriptBlock(loaderSrc)}
</script>`);

  if (frameworkSrc) {
    parts.push(`<script type="text/plain" id="unity-framework-src">
${escapeForScriptBlock(frameworkSrc)}
</script>`);
  }

  parts.push(`<script type="application/json" id="vfs-data">
${escapeJsonForHtml(JSON.stringify(vfs))}
</script>`);

  for (const block of inlineBlocks) {
    parts.push(`<script type="text/plain" id="${block.id}">
${block.base64}
</script>`);
  }

  parts.push(`<script type="application/json" id="build-config">
${escapeJsonForHtml(JSON.stringify(buildConfig))}
</script>`);

  parts.push(`<script id="solo-runtime">
${escapeForScriptBlock(runtimeSrc)}
</script>
</body>
</html>`);

  const html = parts.join('\n');
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, html);
  log(`wrote ${path.relative(repoRoot, opts.out)} (${human(Buffer.byteLength(html))})`);
  if (!opts.inlineAll) {
    log('');
    log('This document still needs the chunks/ folder beside it (or you can pick it from disk).');
    log('Run with --inline-all for one self-contained file (~' + human(Math.ceil(chunkBytes / 3) * 4) + ', not recommended).');
  }
}

main();
