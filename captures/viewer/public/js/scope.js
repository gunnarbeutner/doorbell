// Stacked multi-channel waveform renderer on a single <canvas>. Channels share one X (time) axis;
// each gets its own vertical band, auto-scaled to the visible data. Draws min/max envelope bands
// (or a raw polyline when zoomed in), gridlines, per-channel DC baseline, cursors, hover crosshair,
// and the audio playhead. Pure read from the store; cheap enough to redraw every animation frame.

import { store, elapsed, fromElapsed, valueAt, activeEvents } from './viewstate.js';
import { fitCanvas, niceTicks, fmtTimeShort, fmtVolt } from './util.js';

const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f0883e'];
const PAD_L = 60, PAD_R = 14, PAD_T = 10, AXIS_H = 24, GAP = 10;
const TL_GAP = 8;
const TL_H_RAW = 38, TL_H_HIGH = 58;

// semantic-event colour + glyph by type
const HL = {
  'ring-ours': ['#58a6ff', '●'], 'ring-neighbour': ['#8b949e', '○'], 'ring-kick': ['#6e7681', '◌'],
  gong: ['#d29922', '♪'], session: ['#3fb950', '▬'],
  etagenruf: ['#db61dd', '◉'], 'etagenruf-tone': ['#db61dd', '♬'],
  'door-open': ['#f85149', '⌂'], 'door-neighbour': ['#db6d28', '⌂'], 'door-standalone': ['#db6d28', '⌂'],
  'release-door': ['#bc8cff', '■'], 'release-timeout': ['#f0883e', '■'],
  talk: ['#39c5cf', '▲'], listen: ['#56d4dd', '▼'], 'p2-recovery': ['#6e7681', '↗'],
};
export const hlMeta = (type) => HL[type] || ['#8b949e', '◆'];

export class Scope {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layout = null;
    this.eventHits = []; // [{ i, x0, x1, y0, y1, ev }] for timeline hit-testing
  }

  colorForCh(ch) {
    return COLORS[ch % COLORS.length] || COLORS[0];
  }

  // value of a channel as displayed (DC removed in AC mode)
  disp(c, v) {
    return store.get().acMode ? v - c.vmeanDC : v;
  }

  // compute the visible [min,max] of a channel from its current samples block
  scaleFor(c, block) {
    let mn = Infinity, mx = -Infinity;
    if (block && block.data.length) {
      const d = block.data;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!isFinite(mn)) { mn = c.vmin; mx = c.vmax; }
    let lo = this.disp(c, mn), hi = this.disp(c, mx);
    if (hi - lo < 1e-4) { lo -= 0.1; hi += 0.1; }
    const pad = (hi - lo) * 0.08;
    return { lo: lo - pad, hi: hi + pad };
  }

  computeLayout(w, h) {
    const st = store.get();
    const vis = st.channels.filter((c) => c.visible);
    const win = st.window;
    const showTL = st.showTimeline && activeEvents().length > 0;
    const tlH = st.timelineMode === 'high' ? TL_H_HIGH : TL_H_RAW;
    const tlReserve = showTL ? tlH + TL_GAP : 0;
    const plot = { x: PAD_L, y: PAD_T, w: w - PAD_L - PAD_R, h: h - PAD_T - AXIS_H - tlReserve };
    const n = Math.max(1, vis.length);
    const bandH = (plot.h - GAP * (n - 1)) / n;
    const xOf = (t) => plot.x + ((t - win.t0) / (win.t1 - win.t0)) * plot.w;
    const timeAtX = (px) => win.t0 + ((px - plot.x) / plot.w) * (win.t1 - win.t0);
    const bands = vis.map((c, i) => {
      const y0 = plot.y + i * (bandH + GAP);
      const block = st.samples?.channels?.[c.ch];
      const { lo, hi } = this.scaleFor(c, block);
      const yOf = (vd) => y0 + bandH - ((vd - lo) / (hi - lo)) * bandH;
      return { c, i, y0, h: bandH, lo, hi, yOf, block, color: COLORS[c.ch % COLORS.length] || COLORS[i % COLORS.length] };
    });
    const timeline = showTL ? { x: plot.x, y: plot.y + plot.h + TL_GAP, w: plot.w, h: tlH } : null;
    this.layout = { plot, bands, xOf, timeAtX, win, timeline };
    return this.layout;
  }

  draw() {
    const { ctx } = this;
    const { w, h } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    const st = store.get();
    if (!st.channels.length) {
      ctx.fillStyle = '#7d8590';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText('Select a recording to begin.', 20, 30);
      return;
    }
    const L = this.computeLayout(w, h);
    this.drawTimeGrid(L);
    for (const band of L.bands) this.drawBand(L, band);
    if (L.timeline) this.drawTimeline(L); else this.eventHits = [];
    this.drawDrag(L);
    this.drawCursors(L);
    this.drawHover(L);
    this.drawPlayhead(L);
  }

  drawDrag(L) {
    const d = store.get().drag;
    if (!d) return;
    const { ctx } = this;
    const x0 = L.xOf(Math.min(d.t0, d.t1));
    const x1 = L.xOf(Math.max(d.t0, d.t1));
    ctx.fillStyle = '#58a6ff22';
    ctx.fillRect(x0, L.plot.y, x1 - x0, L.plot.h);
    ctx.strokeStyle = '#58a6ff88';
    ctx.strokeRect(x0, L.plot.y, x1 - x0, L.plot.h);
  }

  drawTimeline(L) {
    if (store.get().timelineMode === 'high') this.drawHighLevelTimeline(L);
    else this.drawPrimitiveTimeline(L);
  }

  drawHighLevelTimeline(L) {
    const { ctx } = this;
    const tl = L.timeline;
    const st = store.get();
    const evs = st.highlevel;
    this.eventHits = [];
    const clipL = tl.x, clipR = tl.x + tl.w;

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(tl.x, tl.y, tl.w, tl.h);
    ctx.strokeStyle = '#222a38';
    ctx.strokeRect(tl.x, tl.y, tl.w, tl.h);
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // faint session bands across the chart for context
    for (const e of evs) {
      if (e.type !== 'session') continue;
      const x0 = Math.max(clipL, L.xOf(e.t)), x1 = Math.min(clipR, L.xOf(e.tEnd));
      if (x1 > x0) { ctx.fillStyle = '#3fb95012'; ctx.fillRect(x0, L.plot.y, x1 - x0, L.plot.h); }
    }

    const spans = evs.map((e, i) => ({ e, i })).filter((o) => o.e.tEnd != null);
    const instants = evs.map((e, i) => ({ e, i })).filter((o) => o.e.tEnd == null);

    // lane-pack span events
    const laneEnd = [];
    const laneOf = new Map();
    for (const o of spans) {
      const x0 = L.xOf(o.e.t);
      let lane = laneEnd.findIndex((end) => end <= x0 - 2);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
      laneEnd[lane] = L.xOf(o.e.tEnd);
      laneOf.set(o.i, lane);
    }
    const nLanes = Math.max(1, laneEnd.length);
    const areaTop = tl.y + 20, areaH = tl.h - 22, slot = areaH / nLanes;
    ctx.textBaseline = 'middle';
    for (const o of spans) {
      const e = o.e;
      let x0 = L.xOf(e.t), x1 = L.xOf(e.tEnd);
      if (x1 < clipL || x0 > clipR) continue;
      x0 = Math.max(clipL, x0); x1 = Math.min(clipR, x1);
      const y = areaTop + laneOf.get(o.i) * slot, h = Math.max(6, slot - 2), w = Math.max(2, x1 - x0);
      const [col, glyph] = hlMeta(e.type);
      ctx.fillStyle = col + (o.i === st.activeEvent ? 'cc' : e.type === 'session' ? '2e' : '66');
      ctx.fillRect(x0, y, w, h);
      ctx.strokeStyle = col;
      ctx.strokeRect(x0, y, w, h);
      if (w > 50) {
        ctx.fillStyle = '#e6edf3';
        ctx.textAlign = 'left';
        ctx.fillText(`${glyph} ${e.title}`, x0 + 4, y + h / 2 + 1);
      }
      this.eventHits.push({ i: o.i, x0, x1: x0 + w, y0: y, y1: y + h, ev: e });
    }

    // instant markers: guide line across chart + flag + title
    for (const o of instants) {
      const e = o.e;
      const x = L.xOf(e.t);
      if (x < clipL - 1 || x > clipR + 1) continue;
      const [col] = hlMeta(e.type);
      const active = o.i === st.activeEvent;
      ctx.strokeStyle = col + (active ? 'cc' : '44');
      ctx.beginPath();
      ctx.moveTo(x, L.plot.y);
      ctx.lineTo(x, tl.y + tl.h);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, tl.y + 8); ctx.lineTo(x + 4, tl.y + 12); ctx.lineTo(x, tl.y + 16); ctx.closePath();
      ctx.fill();
      ctx.font = '9px ui-monospace, monospace';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = x > clipR - 90 ? 'right' : 'left';
      ctx.fillText(e.title, x + (ctx.textAlign === 'right' ? -5 : 5), tl.y + 14);
      this.eventHits.push({ i: o.i, x0: x - 6, x1: x + 6, y0: tl.y, y1: tl.y + 18, ev: e });
    }
  }

  drawPrimitiveTimeline(L) {
    const { ctx } = this;
    const tl = L.timeline;
    const st = store.get();
    this.eventHits = [];
    const clipL = tl.x, clipR = tl.x + tl.w;

    // strip frame + label
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(tl.x, tl.y, tl.w, tl.h);
    ctx.strokeStyle = '#222a38';
    ctx.strokeRect(tl.x, tl.y, tl.w, tl.h);
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // bursts → bars, greedily packed into lanes so simultaneous tones (P4 + P2) stack
    const bursts = st.events.map((e, i) => ({ e, i })).filter((o) => o.e.kind === 'burst');
    const laneEnd = [];
    const laneOf = new Map();
    for (const o of bursts) {
      const x0 = L.xOf(o.e.t);
      let lane = laneEnd.findIndex((end) => end <= x0 - 2);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
      laneEnd[lane] = L.xOf(o.e.tEnd);
      laneOf.set(o.i, lane);
    }
    const nLanes = Math.max(1, laneEnd.length);
    const areaTop = tl.y + tl.h * 0.40, areaH = tl.h * 0.56;
    const laneSlot = areaH / nLanes;
    for (const o of bursts) {
      const e = o.e;
      let x0 = L.xOf(e.t), x1 = L.xOf(e.tEnd);
      if (x1 < clipL || x0 > clipR) continue;
      x0 = Math.max(clipL, x0); x1 = Math.min(clipR, x1);
      const y = areaTop + laneOf.get(o.i) * laneSlot;
      const h = Math.max(4, laneSlot - 2);
      const col = this.colorForCh(e.ch);
      const w = Math.max(2, x1 - x0);
      ctx.fillStyle = col + (o.i === st.activeEvent ? 'cc' : '66');
      ctx.fillRect(x0, y, w, h);
      ctx.strokeStyle = col;
      ctx.strokeRect(x0, y, w, h);
      if (w > 42 && h >= 9) {
        ctx.fillStyle = '#e6edf3';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(`${e.label} tone`, x0 + 4, y + h / 2 + 1);
      }
      this.eventHits.push({ i: o.i, x0, x1: x0 + w, y0: y, y1: y + h, ev: e });
    }

    // edges → guide line across the chart + a direction marker at the top of the strip
    for (let i = 0; i < st.events.length; i++) {
      const e = st.events[i];
      if (e.kind !== 'edge') continue;
      const x = L.xOf(e.t);
      if (x < clipL - 1 || x > clipR + 1) continue;
      const col = this.colorForCh(e.ch);
      const active = i === st.activeEvent;
      ctx.strokeStyle = col + (active ? 'bb' : '2e');
      ctx.beginPath();
      ctx.moveTo(x, L.plot.y);
      ctx.lineTo(x, tl.y + tl.h * 0.5);
      ctx.stroke();
      const my = tl.y + tl.h * 0.26;
      ctx.fillStyle = col;
      ctx.beginPath();
      if (e.dir > 0) { ctx.moveTo(x, my - 5); ctx.lineTo(x - 4, my + 2); ctx.lineTo(x + 4, my + 2); }
      else { ctx.moveTo(x, my + 5); ctx.lineTo(x - 4, my - 2); ctx.lineTo(x + 4, my - 2); }
      ctx.closePath();
      ctx.fill();
      this.eventHits.push({ i, x0: x - 6, x1: x + 6, y0: tl.y, y1: tl.y + tl.h * 0.5, ev: e });
    }
  }

  drawTimeGrid(L) {
    const { ctx } = this;
    const { plot, win } = L;
    const ticks = niceTicks(elapsed(win.t0), elapsed(win.t1), 8);
    const labelY = (L.timeline ? L.timeline.y + L.timeline.h : plot.y + plot.h) + 14;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';
    for (const e of ticks) {
      const x = L.xOf(fromElapsed(e));
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      ctx.strokeStyle = '#1d2230';
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      ctx.fillStyle = '#7d8590';
      ctx.textAlign = 'center';
      ctx.fillText(fmtTimeShort(e), x, labelY);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7d8590';
    ctx.fillText('elapsed', plot.x, labelY);
  }

  drawBand(L, band) {
    const { ctx } = this;
    const { c, y0, h, lo, hi, yOf, block, color } = band;
    const st = store.get();

    // band frame
    ctx.strokeStyle = '#222a38';
    ctx.strokeRect(L.plot.x, y0, L.plot.w, h);

    // horizontal voltage gridlines + labels
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of niceTicks(lo, hi, 4)) {
      const y = yOf(v);
      if (y < y0 - 0.5 || y > y0 + h + 0.5) continue;
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? '#39414f' : '#161c27';
      ctx.beginPath();
      ctx.moveTo(L.plot.x, y);
      ctx.lineTo(L.plot.x + L.plot.w, y);
      ctx.stroke();
      ctx.fillStyle = '#6b7785';
      ctx.fillText(fmtVolt(v, Math.abs(v) >= 10 ? 1 : 2), L.plot.x - 5, y);
    }

    // DC baseline (true mean) reference — only meaningful in DC mode
    if (!st.acMode) {
      const yDC = yOf(c.vmeanDC);
      if (yDC >= y0 && yDC <= y0 + h) {
        ctx.strokeStyle = color + '55';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(L.plot.x, yDC);
        ctx.lineTo(L.plot.x + L.plot.w, yDC);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // waveform
    if (block && block.data.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.plot.x, y0, L.plot.w, h);
      ctx.clip();
      if (block.mode === 'raw') this.drawRaw(L, band);
      else this.drawEnvelope(L, band);
      ctx.restore();
    }

    // channel label
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = color;
    const acTag = st.acMode ? ' · AC' : '';
    ctx.fillText(`${c.label}${acTag}`, L.plot.x + 6, y0 + 4);
  }

  drawEnvelope(L, band) {
    const { ctx } = this;
    const { c, block, yOf, color } = band;
    const { t0, dt, i0, step, buckets, data } = block;
    const tc = (b) => t0 + (i0 + (b + 0.5) * step) * dt;

    // filled min/max band
    ctx.beginPath();
    for (let b = 0; b < buckets; b++) {
      const x = L.xOf(tc(b));
      const y = yOf(this.disp(c, data[2 * b + 1])); // max
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let b = buckets - 1; b >= 0; b--) {
      const x = L.xOf(tc(b));
      ctx.lineTo(x, yOf(this.disp(c, data[2 * b]))); // min
    }
    ctx.closePath();
    ctx.fillStyle = color + '44';
    ctx.fill();

    // mid line
    ctx.beginPath();
    for (let b = 0; b < buckets; b++) {
      const x = L.xOf(tc(b));
      const y = yOf(this.disp(c, (data[2 * b] + data[2 * b + 1]) / 2));
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawRaw(L, band) {
    const { ctx } = this;
    const { c, block, yOf, color } = band;
    const { t0, dt, i0, data } = block;
    ctx.beginPath();
    for (let j = 0; j < data.length; j++) {
      const x = L.xOf(t0 + (i0 + j) * dt);
      const y = yOf(this.disp(c, data[j]));
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    // sample dots when very sparse
    if (data.length <= 120) {
      ctx.fillStyle = color;
      for (let j = 0; j < data.length; j++) {
        const x = L.xOf(t0 + (i0 + j) * dt);
        ctx.fillRect(x - 1, yOf(this.disp(c, data[j])) - 1, 2, 2);
      }
    }
  }

  drawVLine(L, t, color, dash, label) {
    const { ctx } = this;
    const x = L.xOf(t);
    if (x < L.plot.x || x > L.plot.x + L.plot.w) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(x, L.plot.y);
    ctx.lineTo(x, L.plot.y + L.plot.h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = color;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = x > L.plot.x + L.plot.w - 60 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + (ctx.textAlign === 'right' ? -3 : 3), L.plot.y + 1);
    }
    ctx.restore();
  }

  drawCursors(L) {
    const { a, b } = store.get().cursors;
    if (a != null) this.drawVLine(L, a, '#f778ba', [], 'A');
    if (b != null) this.drawVLine(L, b, '#56d4dd', [6, 3], 'B');
  }

  drawHover(L) {
    const st = store.get();
    if (st.hover?.t == null) return;
    this.drawVLine(L, st.hover.t, '#8b949e', [2, 3], null);
    // value dots per band
    const { ctx } = this;
    for (const band of L.bands) {
      const v = valueAt(band.block, band.c.ch, st.meta, st.hover.t);
      if (Number.isNaN(v)) continue;
      const x = L.xOf(st.hover.t);
      const y = band.yOf(this.disp(band.c, v));
      ctx.fillStyle = band.color;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 7);
      ctx.fill();
    }
  }

  drawPlayhead(L) {
    const t = store.get().audio.headTime;
    if (t == null) return;
    this.drawVLine(L, t, '#7ee787', [], '▶');
  }
}
