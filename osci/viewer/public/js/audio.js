// Web Audio playback of a channel's WAV, with a playhead synced to the scope time axis.
//
// The WAV is the DC-removed, peak-normalized audio, sample-aligned with the CSV: wav sample 0 sits
// at scope time = channel.t0. So playing from scope-time T means an AudioBuffer offset of (T - t0)
// seconds, and while playing the playhead scope-time is simply startScopeT + (ctx.currentTime - ctxT0).

import { store } from './viewstate.js';
import { wavUrl } from './api.js';
import { clamp } from './util.js';

export class AudioEngine {
  constructor({ redraw, onState }) {
    this.redraw = redraw;
    this.onState = onState;
    this.ctx = null;
    this.buffers = new Map(); // `${rec}:${ch}` -> AudioBuffer
    this.src = null;
    this.raf = 0;
    this.endScopeT = null;
    this.gain = null;
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async buffer(rec, ch) {
    const key = `${rec}:${ch}`;
    if (this.buffers.has(key)) return this.buffers.get(key);
    const ctx = this.ensureCtx();
    const ab = await (await fetch(wavUrl(rec, ch))).arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    this.buffers.set(key, buf);
    return buf;
  }

  channelMeta(ch) {
    return store.get().meta?.channels.find((c) => c.ch === ch);
  }

  async play(startScopeT, endScopeT = null) {
    const st = store.get();
    if (!st.rec) return;
    const ch = st.listenCh || st.channels.find((c) => c.visible)?.ch || st.channels[0]?.ch;
    if (ch == null) return;
    this.stop();
    const ctx = this.ensureCtx();
    let buf;
    try {
      buf = await this.buffer(st.rec, ch);
    } catch (e) {
      console.warn('audio decode failed', e);
      return;
    }
    const cm = this.channelMeta(ch);
    const t0 = cm ? cm.t0 : st.dataRange.t0;
    const offset = clamp((startScopeT ?? st.window.t0) - t0, 0, buf.duration - 1e-3);
    const dur = endScopeT != null ? clamp(endScopeT - startScopeT, 1e-3, buf.duration - offset) : undefined;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.onended = () => { if (this.src === src) this.stop(); };
    this.src = src;
    this.ctxT0 = ctx.currentTime;
    this.scopeT0 = t0 + offset;
    this.endScopeT = dur != null ? this.scopeT0 + dur : t0 + buf.duration;
    src.start(0, offset, dur);
    store.update((s) => { s.audio.playing = true; s.audio.headTime = this.scopeT0; });
    this.onState?.();
    this.tick();
  }

  tick = () => {
    if (!this.src) return;
    const scopeT = this.scopeT0 + (this.ctx.currentTime - this.ctxT0);
    store.update((s) => { s.audio.headTime = scopeT; });
    this.redraw?.();
    if (scopeT >= this.endScopeT) { this.stop(); return; }
    this.raf = requestAnimationFrame(this.tick);
  };

  stop() {
    if (this.src) {
      try { this.src.onended = null; this.src.stop(); } catch {}
      this.src = null;
    }
    cancelAnimationFrame(this.raf);
    const wasPlaying = store.get().audio.playing;
    store.update((s) => { s.audio.playing = false; });
    if (wasPlaying) { this.onState?.(); this.redraw?.(); }
  }

  toggle() {
    if (store.get().audio.playing) this.stop();
    else this.play(store.get().audio.headTime ?? store.get().window.t0);
  }
}
