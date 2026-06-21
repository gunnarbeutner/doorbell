// High-level (semantic) event detection: reconstruct the TCS/STR intercom protocol from the
// per-channel primitives + the bus pin roles.
//
//   P4 (line4)  — Türruf, address-selective: only OUR door drives it. Hot ⇒ our ring; a sustained
//                 hold ⇒ a sealed-in session.
//   P2 (listen) — shared party line: 12 V idle, sags to the ~9.4 V listen-tie under a call, carries
//                 a neighbour's gong, and is one half of the P2↔P3 door bridge.
//   P3 (talk)   — talk leg + the other half of the door bridge: rising to ~7 V ⇒ a door-open.
//
// From those we classify: our ring vs a neighbour's, session start/hold/end, the release CAUSE
// (door-open vs timeout/no-answer), door-open during a call vs standalone, the 3-Klang gong with
// its descending tones, and talk/listen speech activity.

import { blockStats, detectBursts } from './events.js';
import { toneSequence } from './fft.js';

const ROLE_BY_LABEL = { P4: 'line4', P2: 'listen', P3: 'talk' };
const HOT = 4.0; // V: a line is "hot" (driven) above this
const SESSION_MIN_S = 1.0; // a P4 hold shorter than this is just an unsealed ring kick

// contiguous runs where dc > thr (bridging gaps ≤ gapLen blocks, ≥ minLen blocks)
function spansAbove(dc, thr, tOf, minLen, gapLen) {
  const spans = [];
  const nb = dc.length;
  let k = 0;
  while (k < nb) {
    if (dc[k] > thr) {
      let end = k, gap = 0, j = k;
      while (j < nb) {
        if (dc[j] > thr) { end = j; gap = 0; }
        else if (++gap > gapLen) break;
        j++;
      }
      if (end - k + 1 >= minLen) spans.push({ i0: k, i1: end, t: tOf(k), tEnd: tOf(end) });
      k = j + 1;
    } else k++;
  }
  return spans;
}

function mergeIntervals(items) {
  const a = items.slice().sort((x, y) => x.t - y.t);
  const out = [];
  for (const it of a) {
    const last = out[out.length - 1];
    if (last && it.t <= last.tEnd + 0.25) {
      last.tEnd = Math.max(last.tEnd, it.tEnd);
      last.chans.add(it.ch);
      last.peak = Math.max(last.peak, it.peak || 0);
    } else {
      out.push({ t: it.t, tEnd: it.tEnd, peak: it.peak || 0, chans: new Set([it.ch]) });
    }
  }
  return out;
}

// peak dc of `st` between scope-times [t0,t1]
function maxDcBetween(st, t0, t1) {
  let mx = -Infinity;
  for (let k = st.kOf(t0); k <= st.kOf(t1); k++) mx = Math.max(mx, st.dc[k]);
  return mx;
}

function fmtDur(s) {
  return s >= 1 ? `${s.toFixed(1)} s` : `${(s * 1e3) | 0} ms`;
}

function tones(volts, t, tEnd, rec) {
  const sr = 1 / rec.dt;
  const i0 = Math.max(0, Math.round((t - rec.t0) / rec.dt));
  const i1 = Math.min(rec.n, Math.round((tEnd - rec.t0) / rec.dt));
  const seq = toneSequence(volts, i0, i1, sr);
  return seq.length ? `${seq.join(' → ')} Hz` : null;
}

// AC bursts on a role within (t0,t1), excluding intervals covered by `exclude` (door bridges).
function speechBursts(r, t0, t1, exclude, blockMs) {
  const { ac, tOf, kOf } = r.st;
  const k0 = kOf(t0), k1 = kOf(t1);
  if (k1 - k0 < 5) return [];
  const win = Array.prototype.slice.call(ac, k0, k1).sort((a, b) => a - b);
  const base = win[Math.floor(win.length * 0.3)] || 0;
  const peak = win[win.length - 1] || 0;
  const thr = Math.max(base * 3, base + 0.25, 0.18);
  if (peak < thr) return [];
  const minLen = Math.max(1, Math.round(120 / blockMs));
  const gapLen = Math.max(1, Math.round(150 / blockMs));
  const inExcl = (t) => exclude.some((d) => t >= d.t - 0.15 && t <= d.tEnd + 0.15);
  const out = [];
  let k = k0;
  while (k < k1) {
    if (ac[k] > thr && !inExcl(tOf(k))) {
      let end = k, gap = 0, j = k;
      while (j < k1) {
        if (ac[j] > thr && !inExcl(tOf(j))) { end = j; gap = 0; }
        else if (++gap > gapLen) break;
        j++;
      }
      if (end - k + 1 >= minLen) out.push({ t: tOf(k), tEnd: tOf(end) });
      k = j + 1;
    } else k++;
  }
  return out;
}

// P2 slow recovery: from the bridge end, listen dc climbs back toward 12 V over ~1–2 s.
function recoveryRamp(st, fromBlock) {
  const { dc, nb, tOf } = st;
  if (dc[fromBlock] > 9) return null; // not pulled down → nothing to recover
  const limit = Math.min(nb - 1, fromBlock + st.kOf(st.tOf(fromBlock) + 2.5) - fromBlock + 1);
  for (let k = fromBlock; k <= limit; k++) {
    if (dc[k] > 11) return { t: tOf(fromBlock), tEnd: tOf(k) };
  }
  return null;
}

export function detectHighLevel(items, blockMs = 2) {
  const byRole = {};
  for (const it of items) {
    const role = ROLE_BY_LABEL[it.label];
    if (role) byRole[role] = { ...it, st: blockStats(it.rec, blockMs) };
  }
  const { line4, listen, talk } = byRole;
  const ev = [];
  const blk = (ms) => Math.max(1, Math.round(ms / blockMs));

  // gong bursts (on line 4 and the shared listen line), merged across channels
  const rawBursts = [];
  for (const r of [line4, listen]) {
    if (!r) continue;
    for (const b of detectBursts(r.rec, r.st, r.label, r.ch, blockMs)) rawBursts.push(b);
  }
  const gongs = mergeIntervals(rawBursts);

  // P4 hot spans (sessions vs unsealed kicks); P3 door bridges
  const p4spans = line4 ? spansAbove(line4.st.dc, HOT, line4.st.tOf, blk(50), blk(200)) : [];
  const p3spans = talk ? spansAbove(talk.st.dc, HOT, talk.st.tOf, blk(60), blk(120)) : [];
  const sessions = p4spans.filter((s) => s.tEnd - s.t >= SESSION_MIN_S);

  // rings + gong, classified by whether line 4 went hot at the gong
  for (const g of gongs) {
    const tone = listen ? tones(listen.rec.volts, g.t, g.tEnd, listen.rec)
      : (line4 ? tones(line4.rec.volts, g.t, g.tEnd, line4.rec) : null);
    const ours = line4 && maxDcBetween(line4.st, g.t - 0.2, g.tEnd) > HOT;
    ev.push(ours
      ? { kind: 'hl', type: 'ring-ours', t: g.t, title: 'Our ring (Türruf)', detail: 'line 4 hot + 3-Klang gong' + (tone ? ` · ${tone}` : '') }
      : { kind: 'hl', type: 'ring-neighbour', t: g.t, title: 'Neighbour ring', detail: 'gong on shared P2, line 4 cold' + (tone ? ` · ${tone}` : '') });
    ev.push({ kind: 'hl', type: 'gong', span: true, t: g.t, tEnd: g.tEnd, title: '3-Klang gong', detail: tone || 'doorbell chime' });
  }

  // door bridges: during our call (ÖT) · during a neighbour's call · standalone (no ring at all)
  for (const d of p3spans) {
    const inSession = sessions.some((s) => d.t >= s.t - 0.3 && d.t <= s.tEnd + 0.3);
    const afterRing = gongs.some((g) => d.t >= g.t && d.t - g.tEnd < 60); // within a ring's ~60 s call window
    const held = fmtDur(d.tEnd - d.t); // how long the P2↔P3 bridge (ÖT) was held
    let type = 'door-standalone', title = 'Door open (standalone)', detail = 'P2↔P3 bridge · no call active';
    if (inSession) { type = 'door-open'; title = 'Door open (ÖT)'; detail = 'P2↔P3 bridge ends the call'; }
    else if (afterRing) { type = 'door-neighbour'; title = 'Door open (neighbour call)'; detail = "P2↔P3 bridge during a neighbour's call"; }
    ev.push({ kind: 'hl', type, span: true, t: d.t, tEnd: d.tEnd, title: `${title} · held ${held}`, detail });
    if (listen) {
      const rec = recoveryRamp(listen.st, listen.st.kOf(d.tEnd));
      if (rec) ev.push({ kind: 'hl', type: 'p2-recovery', span: true, t: rec.t, tEnd: rec.tEnd, title: 'P2 recovery', detail: 'line 2 ramps back to 12 V (~1.5 s)' });
    }
  }

  // sessions + release cause
  for (const s of sessions) {
    ev.push({ kind: 'hl', type: 'session', span: true, t: s.t, tEnd: s.tEnd, title: `Session · ${fmtDur(s.tEnd - s.t)}`, detail: 'line 4 sealed in (handset latch)' });
    const door = p3spans.find((d) => Math.abs(d.t - s.tEnd) < 0.8 || (d.t <= s.tEnd && d.tEnd >= s.tEnd - 0.2));
    ev.push(door
      ? { kind: 'hl', type: 'release-door', t: s.tEnd, title: 'Released — door open', detail: 'opener fired; seal-in transfer ends the call' }
      : { kind: 'hl', type: 'release-timeout', t: s.tEnd, title: 'Released — no answer', detail: 'P2 driven low (timeout / hang-up); no door-open' });
  }

  // unsealed ring kick (P4 hot < 1 s, no session)
  for (const k of p4spans.filter((s) => s.tEnd - s.t < SESSION_MIN_S)) {
    ev.push({ kind: 'hl', type: 'ring-kick', t: k.t, title: 'Ring — no seal-in', detail: 'line 4 kick died (no session held)' });
  }

  // speech activity during a session, after the gong
  for (const s of sessions) {
    let gongEnd = s.t;
    for (const g of gongs) if (g.t >= s.t - 0.5 && g.t <= s.tEnd) gongEnd = Math.max(gongEnd, g.tEnd);
    for (const [r, type, title] of [[talk, 'talk', 'Talk (up · P3)'], [listen, 'listen', 'Listen (down · P2)']]) {
      if (!r) continue;
      for (const sp of speechBursts(r, gongEnd + 0.1, s.tEnd, p3spans, blockMs)) {
        ev.push({ kind: 'hl', type, span: true, t: sp.t, tEnd: sp.tEnd, title, detail: `${r.label} AC during the call` });
      }
    }
  }

  ev.sort((a, b) => a.t - b.t || (a.span ? 1 : 0) - (b.span ? 1 : 0));
  return ev;
}
