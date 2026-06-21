// Min/max envelope decimation for a time window at a target pixel width.
//
// Returning [min,max] per pixel bucket (rather than a single decimated sample) preserves the fast
// transients this project cares about — gong onsets, switching edges — that a plain stride or mean
// would alias away. When the window is zoomed in far enough that a bucket would hold <=1 sample we
// return the raw samples instead, so a single gong cycle renders as a crisp line.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// rec = { t0, dt, n, volts }.  Returns { meta, data:Float32Array }.
//   envelope mode: data = [min0,max0, min1,max1, ...] (2 floats / bucket)
//   raw mode:      data = the actual samples in [i0,i1)
export function decimate(rec, tA, tB, px) {
  const { t0, dt, n, volts } = rec;
  px = Math.max(1, Math.floor(px));

  let i0 = clamp(Math.floor((tA - t0) / dt), 0, n);
  let i1 = clamp(Math.ceil((tB - t0) / dt), 0, n);
  if (i1 < i0) i1 = i0;
  const span = i1 - i0;

  const baseMeta = { t0, dt, n, i0, i1 };

  if (span === 0) {
    return { meta: { ...baseMeta, mode: 'envelope', buckets: 0, step: 1 }, data: new Float32Array(0) };
  }

  if (span <= px) {
    // raw: one (or more) pixels per sample
    return {
      meta: { ...baseMeta, mode: 'raw', buckets: span, step: 1 },
      data: volts.slice(i0, i1),
    };
  }

  const step = span / px; // samples per bucket (float)
  const data = new Float32Array(px * 2);
  for (let b = 0; b < px; b++) {
    let s = i0 + Math.floor(b * step);
    let e = i0 + Math.floor((b + 1) * step);
    if (e <= s) e = s + 1;
    if (e > i1) e = i1;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = s; i < e; i++) {
      const v = volts[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    data[2 * b] = mn;
    data[2 * b + 1] = mx;
  }
  return { meta: { ...baseMeta, mode: 'envelope', buckets: px, step }, data };
}
