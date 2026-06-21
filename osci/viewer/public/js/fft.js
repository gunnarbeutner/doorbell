// Minimal zero-dependency FFT (iterative radix-2 Cooley–Tukey) + Hann window + a real-input
// magnitude-spectrum helper. Used for the gong tone analysis (~1010/3032 Hz).

export const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

// in-place complex FFT; re/im are Float64Array of equal power-of-two length
export function fft(re, im) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// Magnitude spectrum of a real signal. Returns { mags:Float64Array(N/2), binHz, n }.
// `samples` is windowed with Hann, mean-subtracted, truncated to the largest power of two <= length.
export function magnitudeSpectrum(samples, sampleRate) {
  let n = nextPow2(samples.length);
  if (n > samples.length) n >>= 1; // largest pow2 that fits
  n = Math.max(2, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = (samples[i] - mean) * w[i];
  fft(re, im);
  const half = n >> 1;
  const mags = new Float64Array(half);
  for (let i = 0; i < half; i++) mags[i] = Math.hypot(re[i], im[i]) / half;
  return { mags, binHz: sampleRate / n, n };
}

// Indices of the top-k spectral peaks (local maxima), strongest first, above an optional minHz.
export function topPeaks(mags, binHz, k = 5, minHz = 60) {
  const peaks = [];
  const minBin = Math.max(1, Math.floor(minHz / binHz));
  for (let i = minBin + 1; i < mags.length - 1; i++) {
    if (mags[i] > mags[i - 1] && mags[i] >= mags[i + 1]) peaks.push({ hz: i * binHz, mag: mags[i] });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, k);
}
