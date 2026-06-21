# osci viewer — interactive scope-recording analysis UI

A local web app for the `osci/` recordings: play the audio, zoom into events, read true
voltages, measure with cursors, and see the gong tones — a live alternative to the static
`<basename>.png` overviews.

## Run

```sh
cd osci/viewer
npm start            # or: npm run dev   → http://localhost:8137
```

No dependencies — `npm install` is a no-op. It uses only Node built-ins (`http`, `zlib`'s
**native zstd**) plus a vanilla-JS canvas frontend. Needs Node ≥ 23 (for `node:zlib` zstd; tested
on v26). Override the port with `PORT=…`, or the data dir with `OSCI_DIR=…` (defaults to `../`).

## What it does

- **Recording dropdown** — every recording in `osci/` (grouped by basename, newest first).
- **Stacked channels** sharing one time axis, auto-scaled per channel. Bus-pin labels (P4/P2/P3,
  editable — double-click a channel chip; persisted per recording in `localStorage`).
- **Zoom / pan** — drag a region to zoom, wheel to zoom about the pointer, shift-wheel or
  alt-drag to pan, double-click / `0` to fit. The server ships a **min/max envelope** (so
  transients aren't aliased away) and switches to **raw samples** once you're zoomed in past
  ~1 sample/pixel.
- **Audio** — Web Audio playback of a channel's WAV with a playhead synced to the time axis.
  Play all (`space`), from cursor A (`c`), or just the visible window (`w`); pick the listen
  channel with `1`/`2`/`3`. (The WAV is DC-removed, peak-normalized AC, so it's audible.)
- **Event timeline** — a strip under the channels, with a clickable side-panel list (click any
  event to zoom to it; toggle the strip with `e`). Two modes:
  - **High-level** (default) — the reconstructed intercom protocol: *our ring* vs a *neighbour's*,
    the *3-Klang gong* with its descending tones, the *session* (seal-in → held span → release,
    classified as **door-open** vs **no-answer/timeout**), *door-open* (ÖT during a call · during a
    neighbour's call · standalone), the *P2-recovery* ramp, and *talk/listen* speech activity. Built
    by combining the primitives with the bus pin roles (P4 = our Türruf, P2 = shared listen + latch
    supply, P3 = talk + door-bridge).
  - **Raw** — the underlying primitives: every DC-level **edge** and AC **tone burst** per channel.
- **Cursors** — click = A, shift-click = B; readout shows Δt, 1/Δt (Hz), and per-channel ΔV.
- **Spectrum** — line **FFT** (`f`) or **spectrogram** (`s`) of the listen channel's AC over the
  active region (cursors A–B, else the visible window). The 3-Klang gong reads ~1010/3032 Hz.
- **AC/DC** toggle (`d`), the recording's `.md` note (rendered), and the legacy `.png` for
  reference.

## How it works

`server.js` routes a small API; `src-server/` does the work:

- `recordings.js` — scan/group files. `csvstore.js` — decode `.csv.zst` (native zstd) and parse
  to a `Float32Array` of true voltages + `{t0, dt}` (uniform time axis → time is implicit).
- `cache.js` — in-memory LRU (256 MB, `OSCI_CACHE_MB`) plus an on-disk binary cache
  (`.cache/*.f32`, gitignored, keyed on source mtime) so the multi-second first parse of a
  multi-million-row recording is paid **once**.
- `decimate.js` / `binio.js` — `GET /api/samples` returns min/max-envelope (or raw) blocks as a
  compact binary body + an `X-Osci-Meta` header. `wav.js` — range-served WAV for seeking.
- `events.js` / `highlevel.js` — `GET /api/events` returns both layers: **primitives** (level
  **edges** = steps in a coarse per-block DC track; tone **bursts** = a *relative* rise of the AC
  envelope above each line's own baseline, so a permanently-noisy high-Z line like P3 isn't mistaken
  for a tone) and **high-level** semantic events (`highlevel.js`), which combine those with the bus
  pin roles into ring/session/door/speech events. `fft.js` does per-burst gong tone-ID.

Frontend modules under `public/js/` (`scope`, `interactions`, `audio`, `fft`, `spectrogram`,
`notes`, …) are plain ESM; the renderer is a custom canvas.

`npm test` runs `node --test` (decimation bucket math, binary framing, CSV parse).
