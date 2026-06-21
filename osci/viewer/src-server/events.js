// Detect events on a recording from the full-resolution channel voltages.
//
// Two kinds, both derived from a coarse per-channel block summary (default 2 ms blocks):
//   - EDGE: a step in the DC level (block mean averages out the AC, so a clean level track). The
//     ring onset (line 4 → hot), the release, a door-open (P3 → high), the P2 session sag, etc.
//   - BURST: a stretch where the AC envelope rises well ABOVE that channel's own baseline AC — the
//     3-Klang gong. The "rise above its own baseline" test is what keeps a permanently-noisy
//     high-impedance line (P3 idles with ~0.6 V RMS of broadband hum) from being flagged as a tone.
//
// Output events are channel-tagged and neutral (pin label + direction + voltage / "tone"); the
// client formats the display text.

export function blockStats(rec, blockMs = 2) {
  const { t0, dt, n, volts } = rec;
  const B = Math.max(1, Math.round(blockMs / 1000 / dt));
  const nb = Math.floor(n / B);
  const dc = new Float32Array(nb);
  const ac = new Float32Array(nb);
  const pk = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    const base = k * B;
    let s = 0;
    for (let i = 0; i < B; i++) s += volts[base + i];
    const m = s / B;
    let ss = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < B; i++) {
      const x = volts[base + i];
      const d = x - m;
      ss += d * d;
      if (x < mn) mn = x;
      if (x > mx) mx = x;
    }
    dc[k] = m;
    ac[k] = Math.sqrt(ss / B);
    pk[k] = (mx - mn) / 2;
  }
  return {
    B, nb, dc, ac, pk, t0, dt,
    tOf: (k) => t0 + (k * B + B / 2) * dt,
    kOf: (t) => Math.max(0, Math.min(nb - 1, Math.round((t - t0) / (dt * B) - 0.5))),
  };
}

function medianSlice(arr, a, b) {
  a = Math.max(0, a); b = Math.min(arr.length, b);
  if (b <= a) return arr[Math.max(0, Math.min(arr.length - 1, a))] || 0;
  const t = Array.prototype.slice.call(arr, a, b).sort((x, y) => x - y);
  return t[t.length >> 1];
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const t = Array.prototype.slice.call(arr).sort((x, y) => x - y);
  return t[Math.min(t.length - 1, Math.max(0, Math.floor((p / 100) * t.length)))];
}

function detectEdges(rec, st, label, ch, blockMs) {
  const { dc, nb, tOf } = st;
  const thr = Math.max(1.0, 0.12 * (rec.vmax - rec.vmin));
  const w = Math.max(1, Math.round(8 / blockMs)); // ~8 ms half-window, in blocks
  const slope = new Float32Array(nb);
  for (let k = w; k < nb - w; k++) slope[k] = dc[k + w] - dc[k - w];

  const out = [];
  const mergeW = 2 * w;
  let k = w;
  while (k < nb - w) {
    if (Math.abs(slope[k]) >= thr) {
      let best = k;
      const stop = Math.min(nb - w, k + mergeW);
      for (let j = k + 1; j < stop; j++) if (Math.abs(slope[j]) > Math.abs(slope[best])) best = j;
      const fromV = medianSlice(dc, best - 3 * w, best - w);
      const toV = medianSlice(dc, best + w, best + 3 * w);
      if (Math.abs(toV - fromV) >= thr) {
        out.push({ kind: 'edge', ch, label, t: tOf(best), dir: Math.sign(toV - fromV), fromV, toV });
      }
      k = best + mergeW;
    } else k++;
  }
  return out;
}

export function detectBursts(rec, st, label, ch, blockMs) {
  const { ac, pk, nb, tOf } = st;
  let peak = 0;
  for (let k = 0; k < nb; k++) if (ac[k] > peak) peak = ac[k];
  const base = percentile(ac, 25);
  const thr = Math.max(base * 4, base + 0.3, 0.25); // relative rise above this line's own AC floor
  if (peak < thr) return [];

  const minBlocks = Math.max(1, Math.round(40 / blockMs)); // ≥40 ms
  const gapBlocks = Math.max(1, Math.round(120 / blockMs)); // bridge ≤120 ms quiet gaps
  const out = [];
  let k = 0;
  while (k < nb) {
    if (ac[k] > thr) {
      let end = k, gap = 0, j = k;
      while (j < nb) {
        if (ac[j] > thr) { end = j; gap = 0; }
        else if (++gap > gapBlocks) break;
        j++;
      }
      if (end - k + 1 >= minBlocks) {
        let pkMax = 0;
        for (let m = k; m <= end; m++) if (pk[m] > pkMax) pkMax = pk[m];
        out.push({ kind: 'burst', ch, label, t: tOf(k), tEnd: tOf(end), peak: pkMax });
      }
      k = j + 1;
    } else k++;
  }
  return out;
}

// items: [{ ch, label, rec }] where rec = { t0, dt, n, volts, vmin, vmax }
export function detectEvents(items, blockMs = 2) {
  const events = [];
  for (const { ch, label, rec } of items) {
    if (!rec.n) continue;
    const st = blockStats(rec, blockMs);
    events.push(...detectEdges(rec, st, label, ch, blockMs));
    events.push(...detectBursts(rec, st, label, ch, blockMs));
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}
