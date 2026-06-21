// Tiny radix-2 FFT + a dominant-tone helper, for server-side gong tone identification.

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Dominant frequency (Hz) of volts[i0..i1) within [fmin,fmax], or null. Hann-windowed, mean-removed,
// with parabolic interpolation for sub-bin accuracy.
export function dominantTone(volts, i0, i1, sampleRate, fmin = 200, fmax = 4000) {
  let len = i1 - i0;
  if (len < 256) return null;
  let N = 1;
  while (N * 2 <= Math.min(len, 8192)) N *= 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let k = 0; k < N; k++) mean += volts[i0 + k];
  mean /= N;
  for (let k = 0; k < N; k++) re[k] = (volts[i0 + k] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)));
  fft(re, im);
  const binHz = sampleRate / N;
  const lo = Math.max(1, Math.floor(fmin / binHz)), hi = Math.min(N >> 1, Math.ceil(fmax / binHz));
  let bestBin = -1, best = -1;
  for (let b = lo; b < hi; b++) {
    const m = re[b] * re[b] + im[b] * im[b];
    if (m > best) { best = m; bestBin = b; }
  }
  if (bestBin < 1) return null;
  const a = Math.hypot(re[bestBin - 1], im[bestBin - 1]);
  const b0 = Math.hypot(re[bestBin], im[bestBin]);
  const c = Math.hypot(re[bestBin + 1] || 0, im[bestBin + 1] || 0);
  const denom = a - 2 * b0 + c;
  const delta = denom ? (0.5 * (a - c)) / denom : 0;
  return (bestBin + delta) * binHz;
}

// Sequence of distinct dominant tones across a burst (catches the descending 3-Klang), e.g. [1011,841,673].
export function toneSequence(volts, i0, i1, sampleRate, segs = 8) {
  const seg = Math.floor((i1 - i0) / segs);
  const raw = [];
  if (seg < 512) {
    const t = dominantTone(volts, i0, i1, sampleRate);
    return t ? [Math.round(t)] : [];
  }
  for (let s = 0; s < segs; s++) {
    const a = i0 + s * seg;
    const t = dominantTone(volts, a, a + seg, sampleRate);
    if (t) raw.push(t);
  }
  const seq = [];
  for (const f of raw) {
    const last = seq[seq.length - 1];
    if (last == null || Math.abs(f - last) / last > 0.06) seq.push(f);
  }
  return seq.slice(0, 4).map((f) => Math.round(f));
}
