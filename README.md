# Video Studio (frontend)

A minimal, **video-only** web interface for a `stable-diffusion.cpp` server that exposes the native `sdcpp` API.

The UI attacks the native `sdcpp` API of an `examples/server` process.
It is a standalone page and may be served from a different origin, or from a subpath, than the API it talks to (the server broadcasts CORS headers so cross-origin calls work).

### API server URL

The API base is resolved in this priority order:

1. A `?api=<base-url>` query-string override (session-scoped).
2. A value configured in the UI (header → **API**), persisted to `localStorage` when available (in-memory otherwise).
3. The default `http://localhost:1234` — the default `--listen-port` of `examples/server`.

For example, a page served at `https://cdn.example.com/ui/` can target a server on another machine with `?api=http://192.168.1.10:1234`.
The server's HTTP API is unchanged; only where the page points its HTTP calls changes.

## Features

- Upload a `.zip` containing a `prompt.txt` plus either nothing, optional `start`/`end` image files, or numbered reference files (images, and reference **video** and **audio**).
  Files are matched by suffix: the prompt is any file whose name ends with `prompt.txt`, and start/end are names like `start`/`end` or ending in `...start.`/`...end.` (any extension).
  Numbered references are typed by extension and numbered **per type** (each starts at 1): image frames (`*1.png` … ≤ 9), video files (`*1.mp4` … ≤ 3, decoded client-side onto a 24 fps frame list (capped) with an optional soundtrack WAV trimmed to the frames' span), and audio clips (`*1.wav` … ≤ 3, transcoded to WAV), with at most 12 reference files total.
  All files must sit at the top level (no subfolders).
- Set width, height, and frame count per upload.
- A browser-side queue that runs one job at a time and auto-advances.
  Queue and history appear as one continuous list: queued items newest-first on top, the running item pinned just above history, and completed videos newest-first below.
  Prompts are collapsed by default.
- Reorder queued items (newest-first, first queued item runs next); remove them.
  Failed/cancelled items and completed history rows are not reorderable.
  Each item's prompt and input images are viewable.
- Completed history items show elapsed time, final frame count, and dimensions; each opens a detail view to download the video, the regenerated source zip, and the input files.
- The queue, in-progress generation, and completed history (including full video + input-file data) persist to **IndexedDB**, which has far larger quota than the ~5 MB `localStorage` cap (a single webm routinely exceeds it, which is why history used to vanish on refresh).
  Everything degrades gracefully to in-memory in private browsing when storage is unavailable.
- After a page refresh, queued items, the currently generating item, and completed history are all restored; the running job resumes by re-polling its saved server id (it degrades to a "generation lost due to page refresh" note if the server no longer has the job).
- Storage usage is tracked visibly in the header, with controls to delete a single history item, delete the oldest `n` generations, or clear all saved history (the currently generating item cannot be deleted).
- While the server is online, the header shows the currently loaded model checkpoint (from the capabilities endpoint's `model` field), hidden when offline or when the server reports none.

The new-job form sets **width, height, frames (default 107), and steps (default 20)**.
Remaining parameters are fixed (fps 24, cfg 1, distilled guidance 3.5) and are not shown in the UI.

## Development

Requires Node 20+ and [Bun](https://bun.sh):

```bash
bun install
bun dev        # static server (scripts/serve.mjs) serving ./app/ on :52760
bun test       # unit tests with Bun's runner (tests/)
bun typecheck  # strict TS check (tsc --noEmit)
bun build      # tsc -p tsconfig.build.json -> app/js/
```

The UI has **zero runtime (browser) dependencies** — zip handling uses the browser-native `DecompressionStream`; `app/index.html` links `app/index.css` and the emitted ESM modules under `app/js/`.

### Build

`bun build` compiles the runtime source with `tsc -p tsconfig.build.json`, emitting ES2022 ES modules into `app/js/` (`app/js` is git-ignored and always regenerated).
No bundler is involved — the browser loads `app/js/main.js` as a `<script type="module">`, and relative imports are standard ESM.

`package.json` pins devDependencies to exact versions and `bun install` records them in `bun.lock`, so builds are reproducible.
Dependencies are `typescript` + `@types/node` + `@types/bun`.
Tests live in `tests/` and use Bun's test runner (`bun:test`) with strict TypeScript checking.

## Production

`bun build` emits `app/index.html` and the compiled `app/js/` modules.
Serve the `app/` directory with any static server.
The API base is configured at run time via the UI or `?api=`; see *API server URL* above.
Note the page may call the API cross-origin, so the serving host must send `Access-Control-Allow-Origin` (the `examples/server` natively broadcasts CORS headers).

## Design notes

**API surface** (all under `<base>/sdcpp/v1/`):

- `GET /capabilities` — prefills width/height/frames defaults and drives the online/offline indicator; its `model` field also supplies the loaded checkpoint name for the header's model indicator (shown only while online).
- `POST /vid_gen` — submits a video job (202 Accepted).
- `GET /jobs/{id}` — polls a job to completion.
- `POST /jobs/{id}/cancel` — best-effort cancel when a running item is removed.

The completed `vid_gen` result does not echo width/height, so history stores the request width/height as the "final used" values, and the server-reported `frame_count` (which the server normalizes to the largest `4n+1 <= requested`) as the final frame count.
Elapsed time is `completed - started` from the job.

**Zip input spec.** A valid zip contains exactly one prompt file plus exactly one of: `prompt.txt` only (`prompt` mode), `start`/`end` image files (`start-end` mode), or numbered reference files (`refs` mode).
References are typed by extension and numbered independently per type, each a contiguous gap-free sequence from 1: image frames (`*1.png`, ≤ 9), reference video files (`*1.mp4`/`*1.webm`/…, ≤ 3), and reference audio clips (`*1.wav`/`*1.mp3`/…, ≤ 3), with ≤ 12 reference files across all types.
Rejected on upload (before any content is read): missing or duplicate prompt, unexpected/extraneous files, files in subfolders (top-level only), mixing `start`/`end` with any numbered reference, a numbered group that is not a contiguous gap-free sequence starting at 1 (including `f1.png` vs `01.png`), exceeding a per-type or the total reference cap, a non-decodable image/video/audio, empty/oversized prompt, oversized files, or a non-zip payload.

File kinds are matched by case-insensitive literal suffix over the lowercased full name: prompt = any name ending in `prompt.txt`; start/end = a name equal to, or ending in, `start.`/`end.` (any extension).
"Ends with a number" means the filename stem (name minus final extension) ending in a digit run (so `frame1.png` and `a.1.png` count; `frame1b.png` does not).
Memory safety: each zip entry's declared uncompressed size is checked before inflation, so a zip-bomb payload cannot be inflated past the limit (uses the browser-native `DecompressionStream`).

**Security invariants.** No `innerHTML`/`eval`/`outerHTML` — DOM is built via a hyperscript helper that inserts text with `createTextNode` and sets attributes via `setAttribute`/`.value`, so prompts and file names cannot inject markup.
The API host is configurable and the page contacts only it (a `referrer no-referrer` meta; no CDNs/fonts/analytics).
All access to `localStorage` and `IndexedDB` is wrapped in try/catch and best-effort, degrading to in-memory (session-only) history in private browsing or on quota pressure.

## Interesting files

- `app/ts/` — runtime TypeScript source (the code you edit).
- `app/index.html` / `app/index.css` — the page and its stylesheet.
- `app/js/` — generated `tsc` output (git-ignored).
- `tests/` — Bun test suites (`bun:test`).
- `scripts/serve.mjs` — dependency-free static server for `bun dev`.
- `tsconfig.json` — strict base config (editor + `tsc --noEmit` typecheck).
- `tsconfig.build.json` — build emit config (`outDir: app/js`, tests excluded).
