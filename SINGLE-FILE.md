# Single-file build

`game/solo.html` is the whole web port folded into one HTML document.

Everything the page used to load as a separate small file is now inside it:

| Packed into `solo.html` | Files | Size |
| --- | --- | --- |
| Markup, styles, pre-Unity browser patches (from `game/index.html`) | 1 | 8 KiB |
| Unity launcher `Build/build.loader.js` | 1 | 58,349 B |
| Unity framework `Build/build.framework.js` | 1 | 1,100,236 B |
| `StreamingAssets/**` (videos, addressables catalog, localisation bundles, credits) | 45 | 4.19 MiB |
| Intro art `assets/port-by-camzzz.png` (as a `data:` URI) | 1 | 212,120 B |
| Runtime that serves all of the above out of the document | 1 | 25 KiB |
| **Total** | **50 → 1** | **7.00 MiB** |

`game/index.html` is untouched and still works as the multi-file entry point.

## What is still outside, and why

The two Unity binaries are not in the document:

| Left out | Parts | Size |
| --- | --- | --- |
| `chunks/build.data.part001…050` | 50 | 898,628,811 B (857.00 MiB) |
| `chunks/build.wasm.part001…019` | 19 | 337,769,441 B (322.12 MiB) |
| **Total** | **69** | **1,236,398,252 B (1.15 GiB)** |

They are split into 18 MB parts only because of GitHub's 100 MB per-file limit.
Inlining them would mean 1,648,531,004 bytes (1.54 GiB) of base64 inside one
document. That is not a browser-loadable HTML file: the parser has to hold the
entire string before any script runs. The data file also barely compresses
(deflate -9 on a sample part: 86.1% of the original), because Unity already
compressed it, so there is no useful way to shrink it.

So "one HTML file" is delivered as **one document + the `chunks/` folder**. If you
want the literal single file anyway:

```bash
node tools/make-single-file.mjs --inline-all
```

That embeds the binaries as base64 blocks and produces a ~1.6 GiB document. It is
generated and boots correctly (see the tests below), but expect it to exhaust
browser memory on a real machine. It is off by default for that reason.

## Running it

**Hosted** — put `solo.html` next to `chunks/` and serve the folder:

```bash
node tools/serve.mjs 8000 game     # http://localhost:8000/ -> /solo.html
```

**From disk, no server** — open `game/solo.html` directly with `file://`. The
launcher, engine and every asset come from the document; the page then asks you
to pick the `chunks` folder (or drop it on the window) and runs entirely from
memory. This is the path that makes the single file usable without hosting
anything.

Pick the `chunks` **folder itself**, not its parent and not one file at a time —
the page needs all 69 parts. It counts what you selected and tells you exactly
what is missing if the pick is short, so you can try again without reloading.

**One file** — `--inline-all`, as above. Needs nothing beside it.

## How the assets are served from inside the document

Unity asks for `StreamingAssets/...` by URL at runtime, so the runtime installs a
small in-memory virtual file system and routes both `fetch()` and
`XMLHttpRequest` through it. Packed paths are answered from the document,
including `Range` requests (the in-game monitors stream their video that way);
anything else falls through to the real network untouched. `blob:` and `data:`
URLs are never intercepted.

## Regenerating and testing

```bash
node tools/make-single-file.mjs              # write game/solo.html
node tools/verify-single-file.mjs            # structure + fidelity + runtime + manifest
node tools/e2e-boot-test.mjs                 # boot the real document over HTTP
```

`verify-single-file.mjs` checks that the inlined launcher, framework, all 45
StreamingAssets files and the intro art decode back byte-identical to their
sources, then loads the shipped `tools/solo-runtime.js` under a DOM shim and
exercises its URL resolver, byte-range handling, `fetch` patch, `XMLHttpRequest`
patch and chunk loader (inlined, HTTP, and folder-picker paths).

`e2e-boot-test.mjs` serves the generated `solo.html` over HTTP with stand-in
chunk parts and runs the real `boot()`: the virtual file system is built from the
real document, the launcher and framework become `blob:` URLs, the parts are
fetched and concatenated in manifest order, and `createUnityInstance` receives the
resulting config. It runs against both the external-chunk build and an
`--inline-all` build.

The folder picker is driven the way a user drives it: the button click has to open
the file dialog, a dropped folder has to be walked through its directory entries,
a short or wrong pick has to be reported and leave the picker open for another
try, and one full pick has to serve both the data and the wasm group.

Both pass here: 103 and 23 checks.

One thing that is **not** covered: this sandbox has no browser, so Unity itself
was never executed. Everything up to and including the config handed to
`createUnityInstance` is verified; the engine running after that point is not.

## Files

| Path | Role |
| --- | --- |
| `game/solo.html` | generated single-file build |
| `tools/make-single-file.mjs` | generator (`--inline-all`, `--out`, `--source`, `--no-framework`) |
| `tools/solo-runtime.js` | browser runtime, inlined verbatim into the document |
| `tools/verify-single-file.mjs` | structure, fidelity, runtime and manifest checks |
| `tools/e2e-boot-test.mjs` | end-to-end boot of the generated document |
| `tools/serve.mjs` | static server with `Range` support and correct content types |
