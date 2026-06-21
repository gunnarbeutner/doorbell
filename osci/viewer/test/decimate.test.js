import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimate } from '../src-server/decimate.js';
import { packSamples } from '../src-server/binio.js';
import { parseCsvBuffer } from '../src-server/csvstore.js';

// rec spanning t0=0, dt=0.001 (1 kHz), n=1000: volts[i] = i
function ramp(n = 1000, t0 = 0, dt = 0.001) {
  const volts = new Float32Array(n);
  for (let i = 0; i < n; i++) volts[i] = i;
  return { t0, dt, n, volts, vmin: 0, vmax: n - 1, vmeanDC: (n - 1) / 2 };
}

test('raw mode when window holds <= px samples', () => {
  const rec = ramp();
  // window [0, 0.01) ~ indices 0..10, px=1600 → raw
  const { meta, data } = decimate(rec, 0, 0.01, 1600);
  assert.equal(meta.mode, 'raw');
  assert.equal(data[0], 0);
  assert.equal(data[1], 1);
  assert.equal(meta.i0, 0);
});

test('envelope mode covers the window with min<=max per bucket', () => {
  const rec = ramp();
  const px = 100;
  const { meta, data } = decimate(rec, 0, 1.0, px); // full record, 1000 samples → 100 buckets
  assert.equal(meta.mode, 'envelope');
  assert.equal(meta.buckets, px);
  assert.equal(data.length, px * 2);
  for (let b = 0; b < px; b++) {
    const mn = data[2 * b], mx = data[2 * b + 1];
    assert.ok(mn <= mx, `bucket ${b}: ${mn} <= ${mx}`);
  }
  // first bucket starts at sample 0, last bucket ends at the max value
  assert.equal(data[0], 0);
  assert.equal(data[px * 2 - 1], 999);
});

test('envelope preserves a single-sample spike (min/max, not mean)', () => {
  const rec = ramp(1000);
  rec.volts[500] = 9999; // lone spike
  rec.vmax = 9999;
  const { data, meta } = decimate(rec, 0, 1.0, 100);
  let maxSeen = -Infinity;
  for (let b = 0; b < meta.buckets; b++) maxSeen = Math.max(maxSeen, data[2 * b + 1]);
  assert.equal(maxSeen, 9999); // spike survives decimation
});

test('window outside the record yields empty', () => {
  const rec = ramp();
  const { data } = decimate(rec, 100, 200, 1600);
  assert.equal(data.length, 0);
});

test('packSamples concatenates blocks and records lengths', () => {
  const rec = ramp();
  const a = decimate(rec, 0, 1.0, 50);
  const b = decimate(rec, 0, 1.0, 50);
  const { meta, body } = packSamples([
    { ch: 1, meta: a.meta, data: a.data },
    { ch: 2, meta: b.meta, data: b.data },
  ]);
  assert.equal(meta.channels.length, 2);
  assert.equal(meta.channels[0].len, a.data.length);
  assert.equal(body.length, (a.data.length + b.data.length) * 4);
  // round-trip the first channel's floats out of the body
  const f = new Float32Array(body.buffer, body.byteOffset, meta.channels[0].len);
  assert.equal(f[0], a.data[0]);
  assert.equal(f[1], a.data[1]);
});

test('parseCsvBuffer reads t0, dt, n, stats from CSV text', () => {
  const csv = 'time_s,volt\n-1.0e+00,2.0\n-9.8e-01,4.0\n-9.6e-01,1.0\n';
  const r = parseCsvBuffer(Buffer.from(csv, 'latin1'));
  assert.equal(r.n, 3);
  assert.equal(r.t0, -1.0);
  assert.ok(Math.abs(r.dt - 0.02) < 1e-9);
  assert.equal(r.vmin, 1);
  assert.equal(r.vmax, 4);
  assert.ok(Math.abs(r.vmeanDC - 7 / 3) < 1e-6);
});
