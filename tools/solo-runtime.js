/*
 * solo-runtime.js
 *
 * Browser runtime for the single-file build of "Gamble With Your Friends - Solo".
 *
 * The generator (tools/make-single-file.mjs) inlines the Unity loader, the Unity
 * framework, every StreamingAssets file and the intro art directly into one HTML
 * document, then appends this file verbatim as the final script element.
 *
 * Because the engine loads StreamingAssets by URL, this file installs a small
 * in-memory virtual file system and routes fetch() and XMLHttpRequest through it
 * so those URLs resolve from the document itself instead of from disk.
 *
 * The only things that are NOT inlined by default are the two huge Unity binaries
 * (build.data ~857 MiB, build.wasm ~322 MiB).  They are resolved in this order:
 *
 *   1. inlined base64 blocks      (--inline-all)
 *   2. HTTP, relative to the page  (hosted next to a chunks/ folder)
 *   3. files picked from disk      (works from a file:// page, no server needed)
 *
 * This file is intentionally free of build-time substitutions so it can be
 * syntax-checked and unit-tested exactly as it ships.
 */
'use strict';
(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  /* ------------------------------------------------------------------ *
   * base64
   * ------------------------------------------------------------------ */

  function b64ToBytes(b64) {
    var bin = g.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * virtual file system
   * ------------------------------------------------------------------ */

  var vfs = new Map();       // key -> { bytes: Uint8Array, type: string }
  var inlineBlocks = new Map(); // key -> element id holding base64 (chunks)
  var pageDir = null;        // lowercased pathname of the directory holding the page

  var MIME = [
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

  function mimeFor(key, fallback) {
    for (var i = 0; i < MIME.length; i++) if (MIME[i][0].test(key)) return MIME[i][1];
    return fallback || 'application/octet-stream';
  }

  function normKey(key) {
    var s = String(key).split('#')[0].split('?')[0];
    try { s = decodeURIComponent(s); } catch (e) { /* keep as-is */ }
    return s.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
  }

  function registerAsset(key, bytes, type) {
    vfs.set(normKey(key), { bytes: bytes, type: type || mimeFor(key) });
  }

  function registerInlineBlock(key, elementId, type) {
    inlineBlocks.set(normKey(key), { id: elementId, type: type || mimeFor(key) });
  }

  function materializeInline(key) {
    var block = inlineBlocks.get(key);
    if (!block) return null;
    var el = g.document && g.document.getElementById(block.id);
    if (!el) return null;
    var bytes = b64ToBytes(el.textContent.replace(/\s+/g, ''));
    // Free the DOM text so a fully-inlined build does not keep it around twice.
    el.textContent = '';
    var entry = { bytes: bytes, type: block.type };
    vfs.set(key, entry);
    inlineBlocks.delete(key);
    return entry;
  }

  function vfsEntry(key) {
    return vfs.get(key) || materializeInline(key);
  }

  function pageBase() {
    if (g.document && g.document.baseURI) return g.document.baseURI;
    if (g.location && g.location.href) return g.location.href;
    return 'http://localhost/';
  }

  function computePageDir() {
    try {
      var path = new URL(pageBase()).pathname;
      var idx = path.lastIndexOf('/');
      pageDir = decodeURIComponent(idx >= 0 ? path.slice(0, idx + 1) : '/').toLowerCase();
    } catch (e) {
      pageDir = '/';
    }
    return pageDir;
  }

  /*
   * Map an absolute or relative URL onto a vfs key, or return null when the URL
   * is not one of ours (so the request falls through to the network).
   */
  function resolveKey(url) {
    if (typeof url !== 'string' || url.length === 0) return null;
    var s = url.split('#')[0].split('?')[0];
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    if (scheme && !/^(https?|file)$/i.test(scheme[1])) return null; // blob:, data:, ws:, ...
    var pathname;
    try {
      pathname = new URL(s, pageBase()).pathname;
    } catch (e) {
      return null;
    }
    try { pathname = decodeURIComponent(pathname); } catch (e) { /* keep as-is */ }
    pathname = pathname.toLowerCase();

    var rel = null;
    if (pageDir && pathname.indexOf(pageDir) === 0) rel = pathname.slice(pageDir.length);
    if (rel && (vfs.has(rel) || inlineBlocks.has(rel))) return rel;

    var bare = pathname.replace(/^\/+/, '');
    if (vfs.has(bare) || inlineBlocks.has(bare)) return bare;

    // Last resort: match on the trailing path so the assets still resolve when
    // the page is served from a sub-path we did not expect.
    var keys = vfs.keys();
    var next = keys.next();
    while (!next.done) {
      if (pathname === next.value || pathname.slice(-next.value.length - 1) === '/' + next.value) return next.value;
      next = keys.next();
    }
    var ikeys = inlineBlocks.keys();
    next = ikeys.next();
    while (!next.done) {
      if (pathname === next.value || pathname.slice(-next.value.length - 1) === '/' + next.value) return next.value;
      next = ikeys.next();
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * byte ranges (Unity's video player streams with Range requests)
   * ------------------------------------------------------------------ */

  function applyRange(bytes, rangeHeader) {
    var total = bytes.length;
    if (!rangeHeader) return { body: bytes, start: 0, end: total - 1, partial: false };
    var m = /bytes\s*=\s*(\d*)\s*-\s*(\d*)/i.exec(rangeHeader);
    if (!m || (m[1] === '' && m[2] === '')) {
      return { body: bytes, start: 0, end: total - 1, partial: false };
    }
    var start, end;
    if (m[1] === '') {
      var suffix = parseInt(m[2], 10);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
    }
    if (isNaN(start)) start = 0;
    if (isNaN(end)) end = total - 1;
    if (end > total - 1) end = total - 1;
    if (start > end || start >= total) {
      return { body: bytes.subarray(0, 0), start: start, end: total - 1, partial: true, unsatisfiable: true };
    }
    return { body: bytes.subarray(start, end + 1), start: start, end: end, partial: true };
  }

  function responseHeaders(entry, slice) {
    var h = {
      'content-type': entry.type,
      'content-length': String(slice.body.length),
      'accept-ranges': 'bytes',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT'
    };
    if (slice.partial) h['content-range'] = 'bytes ' + slice.start + '-' + slice.end + '/' + entry.bytes.length;
    return h;
  }

  /* ------------------------------------------------------------------ *
   * fetch() patch
   * ------------------------------------------------------------------ */

  function installFetchPatch() {
    if (typeof g.fetch !== 'function') return false;
    var nativeFetch = g.fetch.bind(g);
    g.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var key = resolveKey(url);
      if (!key) return nativeFetch(input, init);
      var entry = vfsEntry(key);
      if (!entry) return nativeFetch(input, init);

      var rangeHeader = null;
      try {
        if (init && init.headers) rangeHeader = new g.Headers(init.headers).get('range');
        if (!rangeHeader && input && typeof input !== 'string' && input.headers) rangeHeader = input.headers.get('range');
      } catch (e) { rangeHeader = null; }

      var slice = applyRange(entry.bytes, rangeHeader);
      var status = slice.unsatisfiable ? 416 : (slice.partial ? 206 : 200);
      var headers = new g.Headers();
      var h = responseHeaders(entry, slice);
      for (var name in h) headers.set(name, h[name]);
      var body = status === 416 ? null : slice.body;
      var response = new g.Response(body, {
        status: status,
        statusText: status === 206 ? 'Partial Content' : (status === 416 ? 'Range Not Satisfiable' : 'OK'),
        headers: headers
      });
      return Promise.resolve(response);
    };
    return true;
  }

  /* ------------------------------------------------------------------ *
   * XMLHttpRequest patch
   * ------------------------------------------------------------------ */

  function shadow(obj, name, value) {
    Object.defineProperty(obj, name, { value: value, writable: true, configurable: true, enumerable: true });
  }

  function bodyFor(entry, slice, responseType, overrideMime) {
    if (responseType === 'arraybuffer') {
      // Must hand back a real ArrayBuffer, not a view onto the shared buffer.
      return slice.body.slice().buffer;
    }
    if (responseType === 'blob') return new g.Blob([slice.body], { type: entry.type });
    var text;
    if (overrideMime && /x-user-defined/i.test(overrideMime)) {
      var out = '';
      for (var i = 0; i < slice.body.length; i++) out += String.fromCharCode(slice.body[i]);
      text = out;
    } else {
      text = new g.TextDecoder(entry.type.indexOf('text/') === 0 || /json/.test(entry.type) ? 'utf-8' : 'utf-8').decode(slice.body);
    }
    if (responseType === 'json') { try { return JSON.parse(text); } catch (e) { return null; } }
    return text;
  }

  function installXhrPatch() {
    if (typeof g.XMLHttpRequest !== 'function') return false;
    var proto = g.XMLHttpRequest.prototype;
    var nativeOpen = proto.open;
    var nativeSend = proto.send;
    var nativeSetHeader = proto.setRequestHeader;
    var nativeGetHeader = proto.getResponseHeader;
    var nativeAllHeaders = proto.getAllResponseHeaders;
    var nativeOverrideMime = typeof proto.overrideMimeType === 'function' ? proto.overrideMimeType : null;
    var nativeAbort = typeof proto.abort === 'function' ? proto.abort : null;

    proto.open = function (method, url, async, user, password) {
      var key = resolveKey(url);
      if (!key) {
        this.__vfs = null;
        return nativeOpen.apply(this, arguments);
      }
      this.__vfs = {
        key: key,
        method: String(method || 'GET').toUpperCase(),
        async: async !== false,
        url: url,
        requestHeaders: {},
        responseHeaders: null,
        overrideMime: null,
        aborted: false
      };
      shadow(this, 'readyState', 1);
      shadow(this, 'status', 0);
      shadow(this, 'statusText', '');
      shadow(this, 'response', null);
      shadow(this, 'responseText', '');
      shadow(this, 'responseURL', url);
      return undefined;
    };

    proto.setRequestHeader = function (name, value) {
      if (!this.__vfs) return nativeSetHeader.apply(this, arguments);
      this.__vfs.requestHeaders[String(name).toLowerCase()] = value;
      return undefined;
    };

    proto.overrideMimeType = function (mime) {
      if (!this.__vfs) return nativeOverrideMime ? nativeOverrideMime.apply(this, arguments) : undefined;
      this.__vfs.overrideMime = mime;
      return undefined;
    };

    proto.getResponseHeader = function (name) {
      if (!this.__vfs) return nativeGetHeader.apply(this, arguments);
      if (!this.__vfs.responseHeaders) return null;
      var v = this.__vfs.responseHeaders[String(name).toLowerCase()];
      return v === undefined ? null : v;
    };

    proto.getAllResponseHeaders = function () {
      if (!this.__vfs) return nativeAllHeaders.apply(this, arguments);
      if (!this.__vfs.responseHeaders) return '';
      var parts = [];
      for (var k in this.__vfs.responseHeaders) parts.push(k + ': ' + this.__vfs.responseHeaders[k]);
      return parts.join('\r\n');
    };

    proto.abort = function () {
      if (this.__vfs) { this.__vfs.aborted = true; return undefined; }
      return nativeAbort ? nativeAbort.apply(this, arguments) : undefined;
    };

    function fire(xhr, type, Ctor, init) {
      if (typeof g[Ctor || 'Event'] === 'function') {
        var ev;
        try { ev = new g[Ctor || 'Event'](type, init || {}); } catch (e) { ev = new g.Event(type); }
        if (typeof xhr.dispatchEvent === 'function') { xhr.dispatchEvent(ev); return; }
      }
      var handler = xhr['on' + type];
      if (typeof handler === 'function') handler.call(xhr, { type: type, target: xhr });
    }

    function deliver(xhr) {
      var state = xhr.__vfs;
      if (!state || state.aborted) return;
      var entry = vfsEntry(state.key);
      if (!entry) {
        shadow(xhr, 'readyState', 4);
        shadow(xhr, 'status', 404);
        shadow(xhr, 'statusText', 'Not Found');
        fire(xhr, 'readystatechange');
        fire(xhr, 'error');
        fire(xhr, 'loadend', 'ProgressEvent');
        return;
      }
      var slice = applyRange(entry.bytes, state.requestHeaders['range']);
      var status = slice.unsatisfiable ? 416 : (slice.partial ? 206 : 200);
      state.responseHeaders = responseHeaders(entry, slice);

      shadow(xhr, 'readyState', 2);
      fire(xhr, 'readystatechange');
      shadow(xhr, 'status', status);
      shadow(xhr, 'statusText', status === 206 ? 'Partial Content' : (status === 416 ? 'Range Not Satisfiable' : 'OK'));
      fire(xhr, 'readystatechange');

      shadow(xhr, 'readyState', 3);
      fire(xhr, 'readystatechange');
      fire(xhr, 'progress', 'ProgressEvent', { lengthComputable: true, loaded: slice.body.length, total: entry.bytes.length });

      var payload = status === 416 ? new Uint8Array(0) : slice.body;
      var rt = xhr.responseType || '';
      if (rt === '' || rt === 'text') {
        var text = bodyFor(entry, { body: payload }, 'text', state.overrideMime);
        shadow(xhr, 'responseText', text);
        shadow(xhr, 'response', text);
      } else {
        shadow(xhr, 'response', bodyFor(entry, { body: payload }, rt, state.overrideMime));
      }

      shadow(xhr, 'readyState', 4);
      fire(xhr, 'readystatechange');
      fire(xhr, 'load');
      fire(xhr, 'loadend', 'ProgressEvent');
    }

    proto.send = function (body) {
      if (!this.__vfs) return nativeSend.apply(this, arguments);
      var xhr = this;
      if (this.__vfs.async) setTimeout(function () { deliver(xhr); }, 0);
      else deliver(xhr);
      return undefined;
    };

    return true;
  }

  /* ------------------------------------------------------------------ *
   * chunk resolution
   * ------------------------------------------------------------------ */

  /*
   * Decide whether the chunk parts are reachable over HTTP.  Try HEAD first so a
   * static host that does not implement Range does not ship an 18 MiB part just
   * to answer the question.
   */
  function httpProbe(url) {
    if (typeof g.fetch !== 'function') return Promise.resolve(false);
    return g.fetch(url, { method: 'HEAD' })
      .then(function (r) {
        if (r && r.ok) return true;
        return g.fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
          .then(function (r2) { return !!(r2 && (r2.ok || r2.status === 206)); });
      })
      .catch(function () { return false; });
  }

  /* ------------------------------------------------------------------ *
   * picking the chunk parts off local disk (file:// pages, no server)
   * ------------------------------------------------------------------ */

  var CHUNK_PART = /^build\.(data|wasm)\.part(\d+)$/;
  var localSelection = null; // one pick serves both the data and the wasm group

  function isChunkPart(file) { return CHUNK_PART.test(file.name); }

  function byPart(a, b) {
    var ma = CHUNK_PART.exec(a.name);
    var mb = CHUNK_PART.exec(b.name);
    if (ma[1] !== mb[1]) return ma[1] === 'data' ? -1 : 1;
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  }

  function toArray(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function entryToFile(entry) {
    return new Promise(function (resolve) {
      entry.file(function (f) { resolve(f); }, function () { resolve(null); });
    });
  }

  function readDirectory(entry) {
    return new Promise(function (resolve) {
      var reader = entry.createReader();
      var collected = [];
      var step = function () {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(collected); return; }
          for (var i = 0; i < batch.length; i++) collected.push(batch[i]);
          step(); // readEntries hands back at most 100 entries per call
        }, function () { resolve(collected); });
      };
      step();
    });
  }

  function walkEntry(entry) {
    if (!entry) return Promise.resolve([]);
    if (entry.isFile) {
      return entryToFile(entry).then(function (f) { return f ? [f] : []; });
    }
    if (entry.isDirectory) {
      return readDirectory(entry).then(function (children) {
        return Promise.all(children.map(walkEntry)).then(function (groups) {
          return groups.reduce(function (a, b) { return a.concat(b); }, []);
        });
      });
    }
    return Promise.resolve([]);
  }

  /*
   * A folder dropped on the page is not in dataTransfer.files - browsers only
   * expose it through the directory entries, which have to be walked.
   */
  function dataTransferFiles(dt) {
    if (!dt) return Promise.resolve([]);
    if (dt.items && dt.items.length && dt.items[0] && typeof dt.items[0].webkitGetAsEntry === 'function') {
      var entries = [];
      for (var i = 0; i < dt.items.length; i++) {
        var entry = dt.items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length) {
        return Promise.all(entries.map(walkEntry)).then(function (groups) {
          return groups.reduce(function (a, b) { return a.concat(b); }, []);
        });
      }
    }
    return Promise.resolve(toArray(dt.files));
  }

  /*
   * boot() knows how many parts each group needs, so it can install a validator
   * that checks the whole selection at once.  A direct loadChunkGroup call falls
   * back to validating just its own group.
   */
  var selectionValidator = null;

  function countKind(files, kind) {
    var n = 0;
    for (var i = 0; i < files.length; i++) {
      var m = CHUNK_PART.exec(files[i].name);
      if (m && m[1] === kind) n++;
    }
    return n;
  }

  function shortfall(files, kind, expected) {
    var found = countKind(files, kind);
    return found === expected ? null : 'found ' + found + ' of ' + expected + ' build.' + kind + '.partNNN';
  }

  function selectLocalParts(validator) {
    if (localSelection) return Promise.resolve(localSelection);
    var check = validator || function () { return null; };
    return new Promise(function (resolve, reject) {
      var doc = g.document;
      var panel = doc && doc.getElementById('chunk-picker');
      if (!panel) { reject(new Error('No local file picker is available in this page.')); return; }
      var input = panel.querySelector ? panel.querySelector('input[type=file]') : null;
      var status = panel.querySelector ? panel.querySelector('#chunk-picker-status') : null;
      var settled = false;

      function setStatus(text) { if (status) status.textContent = text; }

      function accept(fileSource) {
        return Promise.resolve(fileSource).then(function (files) {
          if (settled) return;
          var wanted = toArray(files).filter(isChunkPart).sort(byPart);
          if (wanted.length === 0) {
            setStatus('Nothing recognised there. Choose the "chunks" folder itself, or the build.data.partNNN and build.wasm.partNNN files inside it.');
            return;
          }
          var problem = check(wanted);
          if (problem) {
            /* Leave the panel open and the promise pending so the user can
             * simply pick again. */
            setStatus(problem + '. Choose the "chunks" folder that came with this page.');
            return;
          }
          settled = true;
          localSelection = wanted;
          panel.hidden = true;
          resolve(wanted);
        }).catch(function (error) {
          setStatus('Could not read that selection: ' + (error && error.message ? error.message : error));
        });
      }

      function openDialog() { if (input && typeof input.click === 'function') input.click(); }

      panel.hidden = false;
      setStatus('Choose the "chunks" folder that came with this page (click anywhere in this box), or drop it here.');

      if (input) input.addEventListener('change', function () { accept(toArray(input.files)); });
      /* Any click inside the panel opens the dialog - the button included, since
       * its click bubbles up here. */
      panel.addEventListener('click', function (e) { if (e && e.target === input) return; openDialog(); });
      panel.addEventListener('dragover', function (e) { e.preventDefault(); });
      panel.addEventListener('drop', function (e) { e.preventDefault(); accept(dataTransferFiles(e.dataTransfer)); });
      /* A drop that misses the panel must not navigate the page away. */
      if (doc && doc.addEventListener) {
        doc.addEventListener('dragover', function (e) { e.preventDefault(); });
        doc.addEventListener('drop', function (e) { e.preventDefault(); });
      }
    });
  }

  /*
   * The manifest labels its groups "build.data" and "build.wasm", while the file
   * names carry only "data" / "wasm" - compare on that, not on the whole label.
   */
  function chunkKind(label) {
    var m = /(?:^|\.)(data|wasm)$/.exec(String(label));
    return m ? m[1] : String(label);
  }

  function groupFromFiles(files, label, expected) {
    var kind = chunkKind(label);
    var parts = files.filter(function (f) {
      var m = CHUNK_PART.exec(f.name);
      return !!m && m[1] === kind;
    });
    if (parts.length !== expected) {
      throw new Error('Found ' + parts.length + ' of the ' + expected + ' ' + label +
        '.partNNN files in that selection. Choose the "chunks" folder that came with this page.');
    }
    return parts;
  }

  /*
   * Resolve one chunk group (data or wasm) into a Blob made of all of its parts.
   */
  function loadChunkGroup(group, onProgress) {
    var parts = group.parts;
    var blobs = [];

    function inlineAll() {
      return parts.every(function (p) { return inlineBlocks.has(normKey(p)); });
    }

    function fromInline() {
      for (var i = 0; i < parts.length; i++) {
        var entry = materializeInline(normKey(parts[i]));
        if (!entry) throw new Error('Missing inlined chunk ' + parts[i]);
        blobs.push(new g.Blob([entry.bytes]));
        vfs.delete(normKey(parts[i]));
        if (onProgress) onProgress(i + 1, parts.length, group.label);
      }
      return new g.Blob(blobs, { type: group.type });
    }

    function fromHttp() {
      return parts.reduce(function (chain, part, i) {
        return chain.then(function () {
          return g.fetch(part).then(function (r) {
            if (!r.ok) throw new Error('Could not load ' + part + ' (HTTP ' + r.status + ')');
            return r.blob();
          }).then(function (blob) {
            blobs.push(blob);
            if (onProgress) onProgress(i + 1, parts.length, group.label);
          });
        });
      }, Promise.resolve()).then(function () {
        return new g.Blob(blobs, { type: group.type });
      });
    }

    function fromLocal() {
      var kind = chunkKind(group.label);
      var validator = selectionValidator || function (files) {
        var p = shortfall(files, kind, parts.length);
        return p ? p.charAt(0).toUpperCase() + p.slice(1) : null;
      };
      return selectLocalParts(validator).then(function (files) {
        var mine;
        try {
          mine = groupFromFiles(files, group.label, parts.length);
        } catch (error) {
          /* A short or wrong pick must not be remembered, or the user could
           * never retry. */
          localSelection = null;
          throw error;
        }
        for (var i = 0; i < mine.length; i++) {
          blobs.push(mine[i]);
          if (onProgress) onProgress(i + 1, mine.length, group.label);
        }
        return new g.Blob(blobs, { type: group.type });
      });
    }

    if (inlineAll()) return Promise.resolve().then(fromInline);
    return httpProbe(parts[0]).then(function (ok) { return ok ? fromHttp() : fromLocal(); });
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  function readJsonBlock(id) {
    var el = g.document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }

  function textBlock(id) {
    var el = g.document.getElementById(id);
    if (!el) return null;
    // The generator wraps each block in a newline; drop exactly those two so the
    // script we hand the browser is byte-identical to the source file.
    return el.textContent.replace(/^\n/, '').replace(/\n$/, '');
  }

  function scriptFromText(source, label) {
    var blob = new g.Blob([source], { type: 'text/javascript' });
    var url = g.URL.createObjectURL(blob);
    return new Promise(function (resolve, reject) {
      var el = g.document.createElement('script');
      el.src = url;
      el.onload = function () { resolve(url); };
      el.onerror = function () { reject(new Error('Could not evaluate the inlined ' + label + '.')); };
      g.document.body.appendChild(el);
    });
  }

  function buildVfs(config) {
    var assets = readJsonBlock('vfs-data') || {};
    var keys = Object.keys(assets);
    for (var i = 0; i < keys.length; i++) {
      registerAsset(keys[i], b64ToBytes(assets[keys[i]].b), assets[keys[i]].t || mimeFor(keys[i]));
    }
    var inline = (config && config.inlinedChunks) || {};
    var groups = [inline.data, inline.wasm];
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi];
      if (!group || !group.parts) continue;
      for (var pi = 0; pi < group.parts.length; pi++) {
        registerInlineBlock(group.parts[pi].path, group.parts[pi].id, group.type);
      }
    }
    return keys.length;
  }

  function setStatus(text) {
    var el = g.document.getElementById('status');
    if (el) el.textContent = text;
  }

  function setProgress(value) {
    var el = g.document.getElementById('progress');
    if (el) el.value = value;
  }

  function boot() {
    computePageDir();
    var config = readJsonBlock('build-config') || {};
    if (config.chunks && config.chunks.data && config.chunks.wasm) {
      var wantData = config.chunks.data.parts.length;
      var wantWasm = config.chunks.wasm.parts.length;
      selectionValidator = function (files) {
        var problems = [];
        var a = shortfall(files, 'data', wantData);
        var b = shortfall(files, 'wasm', wantWasm);
        if (a) problems.push(a);
        if (b) problems.push(b);
        return problems.length
          ? 'Not all parts are there (' + problems.join(', ') + ')'
          : null;
      };
    }
    var assetCount = buildVfs(config);
    installFetchPatch();
    installXhrPatch();

    var canvas = g.document.getElementById('unity-canvas');
    var objectUrls = [];

    var unityConfig = {
      companyName: 'CamzzzWebPorts',
      productName: 'Gamble With Your Friends - Solo Web Port',
      productVersion: '1.0',
      streamingAssetsUrl: 'StreamingAssets',
      devicePixelRatio: 1,
      autoSyncPersistentDataPath: true
    };

    var loaderSource = textBlock('unity-loader-src');
    var frameworkSource = textBlock('unity-framework-src');

    var chain = Promise.resolve();

    if (!loaderSource) throw new Error('The inlined Unity launcher is missing from this file.');

    chain = chain.then(function () {
      setStatus('Preparing the Unity launcher (' + assetCount + ' assets packed)…');
      return scriptFromText(loaderSource, 'Unity launcher').then(function (url) { objectUrls.push(url); });
    });

    if (frameworkSource) {
      chain = chain.then(function () {
        var blob = new g.Blob([frameworkSource], { type: 'text/javascript' });
        var url = g.URL.createObjectURL(blob);
        objectUrls.push(url);
        unityConfig.frameworkUrl = url;
      });
    } else {
      chain = chain.then(function () { unityConfig.frameworkUrl = config.frameworkUrl; });
    }

    chain = chain.then(function () {
      return loadChunkGroup(config.chunks.data, function (done, total, label) {
        setStatus('Loading ' + label + '… ' + Math.round(done / total * 100) + '%');
      });
    }).then(function (blob) {
      var url = g.URL.createObjectURL(blob);
      objectUrls.push(url);
      unityConfig.dataUrl = url;
    });

    chain = chain.then(function () {
      return loadChunkGroup(config.chunks.wasm, function (done, total, label) {
        setStatus('Loading ' + label + '… ' + Math.round(done / total * 100) + '%');
      });
    }).then(function (blob) {
      var url = g.URL.createObjectURL(blob);
      objectUrls.push(url);
      unityConfig.codeUrl = url;
    });

    chain = chain.then(function () {
      setStatus('Starting game…');
      unityConfig.showBanner = function (message, type) {
        g.console[type === 'error' ? 'error' : 'warn'](message);
      };
      if (typeof g.createUnityInstance !== 'function') {
        throw new Error('The Unity launcher did not expose createUnityInstance().');
      }
      return g.createUnityInstance(canvas, unityConfig, setProgress);
    });

    chain = chain.then(function (instance) {
      g.unityInstance = instance;
      var loading = g.document.getElementById('loading');
      if (loading) loading.remove();
      canvas.focus();
      for (var i = 0; i < objectUrls.length; i++) g.URL.revokeObjectURL(objectUrls[i]);
    });

    return chain;
  }

  /* ------------------------------------------------------------------ *
   * exports / auto-start
   * ------------------------------------------------------------------ */

  var api = {
    b64ToBytes: b64ToBytes,
    registerAsset: registerAsset,
    registerInlineBlock: registerInlineBlock,
    materializeInline: materializeInline,
    loadChunkGroup: loadChunkGroup,
    /* test hooks */
    _resetLocalSelection: function () { localSelection = null; selectionValidator = null; },
    shortfall: shortfall,
    resolveKey: resolveKey,
    applyRange: applyRange,
    responseHeaders: responseHeaders,
    installFetchPatch: installFetchPatch,
    installXhrPatch: installXhrPatch,
    computePageDir: computePageDir,
    normKey: normKey,
    mimeFor: mimeFor,
    boot: boot,
    get size() { return vfs.size; },
    get inlineSize() { return inlineBlocks.size; }
  };

  g.__SoloSingleFile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (g.__SOLO_NO_AUTOBOOT) return;
  if (!g.document || typeof g.document.getElementById !== 'function') return;
  if (!g.document.getElementById('build-config')) return;

  boot().catch(function (error) {
    g.console.error(error);
    setStatus('The game could not start');
    var panel = g.document.getElementById('error');
    if (panel) { panel.hidden = false; panel.textContent = error && error.message ? error.message : String(error); }
  });
})();
