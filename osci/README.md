# osci — Rigol DHO804 capture tooling

Pull waveforms off the bench scope (`osci.beutner.name`) over WiFi and save them — one
**CSV (full true voltages) + WAV (extracted audio) per channel** — so the 3-Klang-Gong
on the bus (and anything else) can be analyzed and listened to.

Built on **[pydho800](https://github.com/MasterJubei/pydho800)** / `pylabdevs`, which talks
to the scope over its raw SCPI socket (:5555) and frames reads/writes reliably. (An earlier
hand-rolled SCPI version hit persistent socket desync and config writes that wouldn't land
on this unit; pydho800 fixed both, so the custom layer was dropped.)

## Analysis UI

For an interactive alternative to the static `.png` overviews — play the audio, zoom into events,
read true voltages, measure with cursors, and view the gong spectrum/spectrogram — run the web
viewer in [`viewer/`](viewer/) (`cd viewer && npm start` → http://localhost:8137). It decompresses
the `.csv.zst` on the fly and has no dependencies. See [`viewer/README.md`](viewer/README.md).

## Setup

```sh
cd osci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Use

```sh
# grab whatever is currently in the scope's memory (STOP + read):
.venv/bin/python capture.py --now --channels 1,2,3 --out grab

# set a ~60 s window, run, and record a session on the P2 line:
.venv/bin/python capture.py --record 60 --channels 2 --mem M_1M --out session

# all three bus lines in parallel, 10x probes (the default):
.venv/bin/python capture.py --now --channels 1,2,3 --out bus

# the displayed time window at full sample density (STOPs, reads memory, trims to the screen):
.venv/bin/python capture.py --screen --channels 1,2,3 --out screen
```

Each run writes `<out>-ch<n>.{csv,wav}` per channel, plus one overview image `<out>.png`
(**DC baseline + AC component per channel**, shared time axis — use `--no-plot` to skip) and a
`<out>.json` sidecar (capture timestamp + acquisition params), and prints sample count, rate, Vpp,
and the dominant chime tones. Channels are read from a single acquisition, so they're **time-aligned**.

> **Filenames carry no timestamp** — pick a unique, descriptive `--out` per capture (e.g.
> `our-ring-door-open`, `door-open-standalone`). The capture date lives in `<out>.json`
> (`captured_at`, ISO 8601), which the viewer reads for its date label and sort; it survives a clone,
> unlike the file mtime.

> **Storage:** raw `.csv` dumps are large (a 180 s, 25 kSa/s capture is ~135 MB/channel, over
> GitHub's 100 MB limit), so the repo tracks the **zstd-compressed `*.csv.zst`** (`zstd --ultra -22`,
> ~4–6× smaller) rather than the raw `.csv`. Compress before committing (`zstd --ultra -22 *.csv`)
> and read back with `zstd -dc file.csv.zst` (or `zstdcat`). The `.wav`, `.png`, `.json`, and
> per-session `.md` are committed uncompressed.

## Modes & options

- **`--now`** — `:STOP` then read the current deep memory.
- **`--record N`** — set a window of ~N seconds (`--divs` is the scope's horizontal
  division count, default 10; the actual window is reported), `:RUN`, wait, `:STOP`, read.
- **`--screen`** — the **displayed time window at full sample density**. `:STOP`, read the deep
  memory (RAW), then trim to the on-screen span — the span is found from a NORMAL-mode read
  (`points × xinc`), so it self-adapts to the current timebase with no hardcoded division count.
  However many samples fall in that window (a few hundred at a fast timebase, millions at a slow
  one). **Requires `:STOP`** — per-sample data only exists in frozen memory. Give exactly one of
  `--now` / `--record` / `--screen`.
- **`--channels 1,2,3`** — 1-based; read in parallel.
- **`--probe 10`** — probe attenuation ratio set on each channel (default 10x).
- **`--mem AUTO|M_1K..M_50M`** — memory depth (default AUTO).
- **Audio extraction:** `--skip-silence`/`--no-skip-silence`, `--min-vpp`,
  `--silence-threshold`, `--hp-ms`, `--pad-ms`, `--min-active-ms`
  (DC-removal high-pass → peak-normalized WAV; idle channels skipped).

## How the audio extraction works

- **DC removal** — a moving-average high-pass strips the line's DC pedestal.
- **WAV = full record by default** — every sample is written (DC-removed, peak-normalized), so
  the timeline is intact. Pass **`--skip-silence`** to instead gate the WAV down to the active
  stretches (AC clearing both a fraction of the peak and the noise floor, ≥ `--min-active-ms`,
  padded by `--pad-ms`).
- **Tone ID** — dominant frequencies from the clean interior of the loudest burst, 80 Hz–5 kHz.
  This always runs on the gated burst (for analysis) regardless of what the WAV contains.

The CSV is always the full, ungated true-voltage record.

## Notes

- Waveform reads come back as **ASCII** (pydho800's format), which is reliable but bulky —
  a multi-megapoint deep read is tens of MB and slow over WiFi. For audio, a modest memory
  depth (`--mem M_1M`) over the window is plenty; keep channel count to what you need.
- The old software-trigger **watch** loop was dropped with the hand-rolled SCPI layer. It can
  be re-added on pydho800 (poll `get_channel_measurement`, then STOP/read) if you want
  continuous event logging again.
