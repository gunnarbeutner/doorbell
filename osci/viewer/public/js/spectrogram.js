// FFT + spectrogram panel. Analyzes the decoded WAV (DC-removed AC, sample-aligned with the CSV) of
// the current listen channel over the active region (cursor A–B if both set, else the visible
// window). Line-FFT shows magnitude vs frequency with peak markers; spectrogram shows a time×freq
// STFT heatmap. The gong should light up around 1010/3032 Hz.

import { store } from './viewstate.js';
import { magnitudeSpectrum, topPeaks, fft, hann, nextPow2 } from './fft.js';
import { fitCanvas, fmtFreq, niceTicks } from './util.js';

const chLabel = (ch) => store.get().channels.find((c) => c.ch === ch)?.label || `CH${ch}`;

const MAX_FFT = 1 << 16; // cap samples fed to a single FFT
const FREQ_MAX_DEFAULT = 5000; // Hz shown by default (gong band)

export class SpectrogramPanel {
  constructor({ canvas, peaksEl, audioEngine }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaksEl = peaksEl;
    this.audio = audioEngine;
    this.mode = 'fft'; // 'fft' | 'spectrogram'
    this.freqMax = FREQ_MAX_DEFAULT;
    this.token = 0;
  }

  region() {
    const st = store.get();
    const { a, b } = st.cursors;
    if (a != null && b != null) return [Math.min(a, b), Math.max(a, b)];
    return [st.window.t0, st.window.t1];
  }

  async update() {
    const st = store.get();
    const my = ++this.token;
    if (!st.rec || !st.meta) return this.message('—');
    const ch = st.listenCh || st.channels.find((c) => c.visible)?.ch;
    const cm = st.meta.channels.find((c) => c.ch === ch);
    if (!cm) return this.message('—');

    let buf;
    try {
      this.message(`analyzing CH${ch}…`);
      buf = await this.audio.buffer(st.rec, ch);
    } catch {
      return this.message('audio decode failed');
    }
    if (my !== this.token) return; // superseded

    const sr = buf.sampleRate;
    const cd = buf.getChannelData(0);
    const [tA, tB] = this.region();
    let i0 = Math.max(0, Math.floor((tA - cm.t0) * sr));
    let i1 = Math.min(cd.length, Math.ceil((tB - cm.t0) * sr));
    if (i1 - i0 < 16) return this.message('region too short');

    if (this.mode === 'fft') this.drawFFT(cd, i0, i1, sr, ch);
    else this.drawSpectrogram(cd, i0, i1, sr, ch);
  }

  message(txt) {
    const { ctx } = this;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#7d8590';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(txt, 8, 18);
    if (this.peaksEl) this.peaksEl.textContent = '';
  }

  drawFFT(cd, i0, i1, sr, ch) {
    // take up to MAX_FFT samples centered in the region
    let len = i1 - i0;
    if (len > MAX_FFT) { i0 += ((len - MAX_FFT) >> 1); len = MAX_FFT; }
    const slice = cd.subarray(i0, i0 + len);
    const { mags, binHz } = magnitudeSpectrum(slice, sr);
    const peaks = topPeaks(mags, binHz, 5, 80);

    const { ctx } = this;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    const padL = 4, padB = 16, padT = 4, padR = 4;
    const pw = w - padL - padR, ph = h - padB - padT;
    const fmax = this.freqMax;
    const nb = Math.min(mags.length, Math.floor(fmax / binHz));
    let peakMag = 1e-9;
    for (let i = 1; i < nb; i++) peakMag = Math.max(peakMag, mags[i]);

    const xOf = (hz) => padL + (hz / fmax) * pw;
    const yOf = (mag) => padT + ph - (mag / peakMag) * ph;

    // freq gridlines
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const f of niceTicks(0, fmax, 6)) {
      const x = xOf(f);
      ctx.strokeStyle = '#1d2230';
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.fillStyle = '#6b7785';
      ctx.fillText(f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${f}`, x, h - 4);
    }
    // spectrum
    ctx.beginPath();
    for (let i = 1; i < nb; i++) {
      const x = xOf(i * binHz), y = yOf(mags[i]);
      i === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1;
    ctx.stroke();
    // peak markers
    ctx.fillStyle = '#f778ba';
    for (const p of peaks) {
      if (p.hz > fmax) continue;
      const x = xOf(p.hz), y = yOf(p.mag);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
    }
    if (this.peaksEl) {
      this.peaksEl.innerHTML = `${chLabel(ch)} peaks: ` +
        peaks.map((p) => `<b>${fmtFreq(p.hz)}</b>`).join(' · ');
    }
  }

  drawSpectrogram(cd, i0, i1, sr, ch) {
    const total = i1 - i0;
    const winN = total > 200000 ? 2048 : 1024;
    const targetCols = 420;
    const hop = Math.max(1, Math.floor((total - winN) / targetCols)) || 1;
    const cols = Math.max(1, Math.floor((total - winN) / hop));
    const binHz = sr / winN;
    const binsShown = Math.min(winN >> 1, Math.floor(this.freqMax / binHz));
    const w = hann(winN);
    const re = new Float64Array(winN), im = new Float64Array(winN);

    const img = new ImageData(cols, binsShown);
    let gmax = 1e-9;
    const colMags = new Float32Array(cols * binsShown);
    for (let c = 0; c < cols; c++) {
      const base = i0 + c * hop;
      let mean = 0;
      for (let k = 0; k < winN; k++) mean += cd[base + k];
      mean /= winN;
      for (let k = 0; k < winN; k++) { re[k] = (cd[base + k] - mean) * w[k]; im[k] = 0; }
      fft(re, im);
      for (let bIdx = 0; bIdx < binsShown; bIdx++) {
        const m = Math.hypot(re[bIdx], im[bIdx]);
        colMags[c * binsShown + bIdx] = m;
        if (m > gmax) gmax = m;
      }
    }
    const logMax = Math.log10(gmax + 1e-9);
    for (let c = 0; c < cols; c++) {
      for (let bIdx = 0; bIdx < binsShown; bIdx++) {
        const m = colMags[c * binsShown + bIdx];
        const norm = Math.max(0, (Math.log10(m + 1e-9) - (logMax - 3)) / 3); // 3 decades
        const [r, g, b] = magma(Math.min(1, norm));
        const y = binsShown - 1 - bIdx; // low freq at bottom
        const o = (y * cols + c) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    // blit scaled
    const { ctx } = this;
    const { w: cw, h: chh } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, cw, chh);
    const off = document.createElement('canvas');
    off.width = cols; off.height = binsShown;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const padB = 14;
    ctx.drawImage(off, 0, 0, cols, binsShown, 0, 0, cw, chh - padB);
    // freq axis labels (right)
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (const f of niceTicks(0, binsShown * binHz, 4)) {
      const y = (chh - padB) * (1 - f / (binsShown * binHz));
      ctx.fillText(f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${f | 0}`, 2, Math.max(8, y));
    }
    if (this.peaksEl) this.peaksEl.textContent = `${chLabel(ch)} · ${cols} cols × ${binsShown} bins · ${(binHz).toFixed(0)} Hz/bin`;
  }
}

// compact magma-ish colormap, t in [0,1] -> [r,g,b]
function magma(t) {
  const r = Math.min(255, Math.max(0, 255 * (1.4 * t - 0.1)));
  const g = Math.min(255, Math.max(0, 255 * (1.6 * t * t - 0.2)));
  const b = Math.min(255, Math.max(0, 255 * (0.9 * Math.sin(Math.PI * t * 0.9) + 0.15 * t)));
  return [r, g, b];
}
