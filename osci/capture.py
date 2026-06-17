#!/usr/bin/env python3
"""Capture Rigol DHO804 waveforms over the network -> per-channel CSV + WAV.

Built on the pydho800 / pylabdevs library, which talks to the scope over its raw SCPI
socket (:5555) and -- unlike hand-rolled SCPI -- frames reads/writes reliably (no desync)
and lands timebase / memory-depth / probe-ratio config that the scope otherwise drops.

Modes (give exactly one):
  --now             read the current deep memory (STOP + grab), then exit
  --record N        set a ~N-second window, RUN, wait, STOP, grab, then exit
  --screen          STOP, read the deep memory, and trim to the DISPLAYED time window -- the full
                    per-sample density inside whatever time frame is on screen (STOP required:
                    per-sample data only exists in frozen memory)
(the old software-trigger "watch" loop was dropped with the hand-rolled SCPI layer.)

Per channel it writes:
  <out>-<ts>-ch<n>.csv   full true voltages (time_s, volt), for analysis
  <out>-<ts>-ch<n>.wav   16-bit PCM of the AC content (DC pedestal removed, peak-normalized),
                         the FULL record by default; pass --skip-silence to gate flat stretches.
Plus one overview image (unless --no-plot):
  <out>-<ts>.png         DC baseline + AC component per channel, on a shared time axis.
Idle channels (no tone and Vpp < --min-vpp) are skipped for CSV/WAV but still plotted.
Channels are read in parallel from one acquisition, so they're time-aligned.

Examples:
  ./capture.py --now --channels 1,2,3 --out grab
  ./capture.py --record 60 --channels 2 --mem M_1M --out session
"""

import argparse
import csv
import time
import wave
from datetime import datetime

import numpy as np
from pydho800.pydho800 import PYDHO800
from labdevices.oscilloscope import OscilloscopeRunMode, OscilloscopeSweepMode, OscilloscopeCouplingMode


# ----- audio extraction (unchanged DSP) ---------------------------------------

def dc_baseline(volts, fs, hp_ms):
    """The (possibly stepping) DC pedestal: a moving-average baseline of the signal."""
    w = max(1, int(fs * hp_ms / 1000))
    if w < 2 or w >= len(volts):
        return np.full(len(volts), float(np.mean(volts)))
    c = np.cumsum(np.insert(volts, 0, 0.0))
    ma = (c[w:] - c[:-w]) / w
    pad_l = w // 2
    pad_r = len(volts) - len(ma) - pad_l
    base = np.concatenate([np.full(pad_l, ma[0]), ma, np.full(max(pad_r, 0), ma[-1])])
    return base[:len(volts)]


def highpass(volts, fs, hp_ms):
    """Strip the DC pedestal: subtract the moving-average baseline -> the AC component."""
    return volts - dc_baseline(volts, fs, hp_ms)


def _runs(mask):
    edges = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def voiced_mask(ac, fs, thr_frac, frame_ms, min_active_ms, pad_ms, snr=4.0):
    n = len(ac)
    frame = max(1, int(fs * frame_ms / 1000))
    nf = n // frame
    if nf < 2:
        return np.ones(n, bool)
    rms = np.sqrt((ac[:nf * frame].reshape(nf, frame) ** 2).mean(axis=1))
    peak = float(rms.max()) or 1.0
    floor = float(np.median(rms))
    thr = max(thr_frac * peak, snr * floor)
    active = rms >= thr
    min_a = max(1, round(min_active_ms / frame_ms))
    pad = round(pad_ms / frame_ms)
    keep = np.zeros(nf, bool)
    for s, e in _runs(active):
        if e - s >= min_a:
            keep[max(0, s - pad):min(nf, e + pad)] = True
    mask = np.repeat(keep, frame)
    if len(mask) < n:
        mask = np.concatenate([mask, np.zeros(n - len(mask), bool)])
    return mask


def tone_segment(ac, mask, fs, trim_ms=50.0):
    runs = _runs(mask)
    if not runs:
        return np.array([])
    s, e = max(runs, key=lambda r: r[1] - r[0])
    trim = int(fs * trim_ms / 1000)
    return ac[s + trim:e - trim] if (e - s) > 2 * trim + 16 else ac[s:e]


def dominant_tones(ac, fs, n=5, min_sep_hz=30.0, min_freq=80.0, max_freq=5000.0, rel=0.15):
    if len(ac) < 16 or fs <= 0:
        return []
    spec = np.abs(np.fft.rfft(ac * np.hanning(len(ac))))
    freqs = np.fft.rfftfreq(len(ac), d=1.0 / fs)
    spec[(freqs < min_freq) | (freqs > max_freq)] = 0.0
    picked = []
    for i in np.argsort(spec)[::-1]:
        f = freqs[i]
        if all(abs(f - pf) >= min_sep_hz for pf, _ in picked):
            picked.append((f, spec[i]))
        if len(picked) >= n:
            break
    if not picked:
        return []
    top = picked[0][1]
    return sorted(f for f, m in picked if m >= rel * top)


def write_wav(path, samples, fs):
    peak = float(np.max(np.abs(samples))) or 1.0
    pcm = np.int16(np.clip(samples / peak, -1.0, 1.0) * 32767)
    rate = max(1, int(round(fs)))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return rate


def write_csv(path, t, volts):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_s", "volt"])
        for ti, vi in zip(t, volts):
            w.writerow([f"{ti:.9e}", f"{vi:.6e}"])


def _decimate(t, y, nbins=2500):
    """Down-sample for plotting: per bin return (t_center, mean, min, max) so transients survive."""
    n = len(y)
    if n <= nbins:
        return t, y, y, y
    per = n // nbins
    m = per * nbins
    yb = y[:m].reshape(-1, per)
    tb = t[:m].reshape(-1, per)
    return tb.mean(1), yb.mean(1), yb.min(1), yb.max(1)


def write_plot(path, t, plot_data, hp_ms):
    """plot_data = list of (ch, volts, dc, ac). Write a PNG: one row per channel, DC baseline
    (left, true level) and AC component (right, min/max envelope), on a shared elapsed-time axis."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  (matplotlib not installed; skipping PNG -- pip install matplotlib)")
        return False
    te = t - t[0]                                    # 0-based elapsed seconds
    n = len(plot_data)
    fig, axes = plt.subplots(n, 2, figsize=(13, 2.4 * n), squeeze=False, sharex=True)
    for i, (ch, volts, dc, ac) in enumerate(plot_data):
        td, dcm, _, _ = _decimate(te, dc)
        ta, _, amin, amax = _decimate(te, ac)
        axL, axR = axes[i]
        axL.plot(td, dcm, color="tab:blue", lw=0.8)
        axL.set_ylabel(f"CH{ch}\nvolts")
        axL.grid(True, alpha=0.3)
        axR.fill_between(ta, amin, amax, color="tab:red", lw=0, alpha=0.85)
        axR.axhline(0, color="0.6", lw=0.5)
        axR.grid(True, alpha=0.3)
    axes[0][0].set_title("DC component (baseline / pedestal)")
    axes[0][1].set_title(f"AC component (high-pass {hp_ms:g} ms, min/max envelope)")
    for c in (0, 1):
        axes[-1][c].set_xlabel("time (s)")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return True


# ----- per-event processing ---------------------------------------------------

def process_capture(d, chans, out_base, args):
    """d = query_waveform result {x, y0, y1, ...}; write CSV+WAV per active channel, and
    (unless --no-plot) one PNG showing the DC baseline + AC component for every channel."""
    x = np.asarray(d["x"], dtype=float)
    fs = (len(x) - 1) / (x[-1] - x[0]) if len(x) > 1 and x[-1] > x[0] else 0.0
    plot_data = []
    written = 0
    for i, ch in enumerate(chans):
        volts = np.asarray(d[f"y{i}"], dtype=float)
        if len(volts) != len(x):
            print(f"  CH{ch}: length mismatch ({len(volts)} vs {len(x)}) -- skipped")
            continue
        dc = dc_baseline(volts, fs, args.hp_ms)
        ac = volts - dc
        plot_data.append((ch, volts, dc, ac))
        mask = voiced_mask(ac, fs, args.silence_threshold, 10.0, args.min_active_ms, args.pad_ms)
        vpp = float(np.ptp(volts))
        if not (mask.any() or vpp >= args.min_vpp):
            print(f"  CH{ch}: idle ({vpp:.2f} Vpp) -- not written (still plotted)")
            continue
        base = f"{out_base}-ch{ch}"
        write_csv(f"{base}.csv", x, volts)
        audio = ac[mask] if (args.skip_silence and mask.any()) else ac
        rate = write_wav(f"{base}.wav", audio, fs)
        written += 1
        tones = dominant_tones(tone_segment(ac, mask, fs), fs)
        tone_s = ", ".join(f"{f:.0f} Hz" for f in tones) if tones else "—"
        gate_note = f", WAV {len(audio)/fs*1e3:.0f} ms (gated)" if (args.skip_silence and mask.any()) else ""
        print(f"  CH{ch}: {len(volts):,} samp @ {fs:,.0f} Sa/s, {(x[-1]-x[0])*1e3:.0f} ms, "
              f"Vpp {vpp:.2f} V{gate_note}; tones: {tone_s}")
        if rate > 192000:
            print(f"        ! {rate} Hz WAV is above audio range -- use a slower window for a listenable WAV")
    if args.plot and plot_data:
        if write_plot(f"{out_base}.png", x, plot_data, args.hp_ms):
            print(f"  wrote {out_base}.png ({len(plot_data)} channel(s): DC + AC)")
    return written


def wait_stopped(dho, timeout=120.0):
    """Block until the scope reports STOP. Raw-mode reads require it, and finalizing a large
    acquisition (deep memory at a slow timebase) can take well over a minute after :STOP."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if dho.get_run_mode() == OscilloscopeRunMode.STOP:
            return True
        time.sleep(0.3)
    return False


def displayed_window(dho, ch0):
    """(t_start, t_end) of the on-screen window, read from a NORMAL-mode trace -- NORMAL spans
    exactly the display, so points*xinc is the shown time frame regardless of the timebase /
    division count. Returns None if it can't be read (then the full memory is kept untrimmed)."""
    try:
        dho._rawMode = False                         # NORMAL = the screen-rendered window
        x = np.asarray(dho.query_waveform((ch0,))["x"], dtype=float)
        if len(x) >= 2 and x[-1] > x[0]:
            return float(x[0]), float(x[-1])
    except Exception as e:                            # noqa: BLE001 -- fall back to full memory
        print(f"  warning: couldn't read the on-screen window ({e}); keeping full memory")
    finally:
        dho._rawMode = True
    return None


def trim_to_window(d, t0, t1):
    """Keep only the samples whose time falls within [t0, t1] (the on-screen window)."""
    x = np.asarray(d["x"], dtype=float)
    mask = (x >= t0) & (x <= t1)
    if not mask.any():
        return d                                      # window didn't intersect the read -- keep all
    out = {"x": x[mask]}
    for k, v in d.items():
        if k != "x":
            out[k] = np.asarray(v, dtype=float)[mask]
    return out


# ----- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Capture DHO804 waveforms over the network -> CSV + WAV")
    ap.add_argument("--host", default="osci.beutner.name", help="scope hostname/IP")
    ap.add_argument("--channels", default="1", help="comma list, 1-based, e.g. 1,2,3 (default 1)")
    ap.add_argument("--probe", type=float, default=10.0, help="probe attenuation ratio per channel (default 10x)")
    ap.add_argument("--out", default="capture", help="output basename -> <out>-<ts>-ch<n>.csv/.wav")
    ap.add_argument("--now", action="store_true", help="grab current deep memory (STOP + read), then exit")
    ap.add_argument("--record", type=float, default=0, help="set a ~N-second window, RUN, wait, STOP, grab")
    ap.add_argument("--screen", action="store_true",
                    help="STOP + read deep memory, trimmed to the on-screen time window (full sample density)")
    ap.add_argument("--mem", default="AUTO",
                    choices=["AUTO", "M_1K", "M_10K", "M_100K", "M_1M", "M_10M", "M_25M", "M_50M"],
                    help="memory depth (default AUTO; the scope clamps to its max for the window)")
    ap.add_argument("--divs", type=float, default=10.0, help="horizontal divisions, for --record window math")
    ap.add_argument("--plot", action=argparse.BooleanOptionalAction, default=True,
                    help="write a PNG visualizing DC baseline + AC component per channel (default on)")
    # audio extraction
    ap.add_argument("--skip-silence", action=argparse.BooleanOptionalAction, default=False,
                    help="gate flat/silent stretches out of each WAV (default off — WAV holds the full record)")
    ap.add_argument("--min-vpp", type=float, default=0.5,
                    help="per channel: write only if it has a tone or Vpp >= this (default 0.5 V)")
    ap.add_argument("--silence-threshold", type=float, default=0.05, help="activity threshold (frac of peak RMS)")
    ap.add_argument("--hp-ms", type=float, default=20.0, help="DC-removal window, ms")
    ap.add_argument("--pad-ms", type=float, default=30.0, help="keep this much around bursts, ms")
    ap.add_argument("--min-active-ms", type=float, default=50.0, help="ignore bursts shorter than this")
    args = ap.parse_args()

    if sum([bool(args.record), args.now, args.screen]) != 1:
        ap.error("give exactly one mode: --now, --record N, or --screen")

    chans = [int(c) for c in args.channels.split(",") if c.strip()]
    idx = tuple(ch - 1 for ch in chans)        # pydho800 channels are 0-based

    with PYDHO800(address=args.host, port=5555, useNumpy=True, rawMode=True) as dho:
        idn = dho.identify()
        print(f"Connected: {idn['manufacturer']} {idn['product']}")
        print(f"Channels: {', '.join('CH' + str(c) for c in chans)}")

        if args.record:
            for ch in chans:                                     # configure only for a fresh capture
                dho.set_channel_enable(ch - 1, True)
                dho.set_channel_probe_ratio(ch - 1, args.probe)
                dho.set_channel_coupling(ch - 1, OscilloscopeCouplingMode.DC)
            print(f"  probe {args.probe:g}x, mem {args.mem}")
            dho.set_memory_depth(PYDHO800.memory_depth_t.AUTO)  # uncap the timebase from any fixed depth
            dho.set_timebase_scale(args.record / args.divs)     # then set the ~N-second window
            dho.set_memory_depth(getattr(PYDHO800.memory_depth_t, args.mem))  # then lock the requested depth
            dho.set_sweep_mode(OscilloscopeSweepMode.AUTO)       # free-run so it captures
            dho.set_run_mode(OscilloscopeRunMode.RUN)
            print(f"Recording ~{args.record:g}s -- go.")
            time.sleep(args.record + 1.0)
            dho.set_run_mode(OscilloscopeRunMode.STOP)
        elif args.now:
            # Non-destructive: read what's already in memory. Don't RUN, don't reconfigure
            # channels (probe/coupling/enable can clear or rescale the buffer) -- just freeze
            # and read at the channels' current settings. :STOP on a stopped scope is a no-op.
            dho.set_run_mode(OscilloscopeRunMode.STOP)
        elif args.screen:
            # Full per-sample density inside the DISPLAYED window. Per-sample data lives only in
            # frozen memory, so STOP and read RAW, then trim to the on-screen span (below).
            dho.set_run_mode(OscilloscopeRunMode.STOP)

        if not wait_stopped(dho):
            print("  warning: scope did not report STOP within timeout; the read may fail")

        win = displayed_window(dho, idx[0]) if args.screen else None
        if win:
            print(f"  on-screen window: {(win[1] - win[0]) * 1e3:.3f} ms")
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        what = "on-screen window" if args.screen else "deep-memory"
        print(f"[{ts}] reading {what}, {len(chans)} channel(s)...")
        d = dho.query_waveform(idx)
        if win:
            n_full = len(np.asarray(d["x"]))
            d = trim_to_window(d, win[0], win[1])
            print(f"  trimmed {n_full:,} -> {len(np.asarray(d['x'])):,} samples (the displayed window)")
        if not process_capture(d, chans, f"{args.out}-{ts}", args):
            print("  no activity on any channel -- nothing written")


if __name__ == "__main__":
    main()
