#!/usr/bin/env node
// Optional seeded sensitivity diagnostic for the watchdog RC. Deterministic named extremes in
// test/corner-qualification.test.js remain the safety gate; this sampler looks for unexpected
// interior interactions and prints the exact seed needed to reproduce any result.
import { createStepper } from '../src/engine.js';
import { mulberry32, PART_LIMITS, uniform } from '../src/corners.js';

const seed = Number(process.argv[2] ?? 0x5eedc0de);
const samples = Number(process.argv[3] ?? 250);
if (!Number.isInteger(seed) || !Number.isInteger(samples) || samples < 1 || samples > 10000)
  throw new Error('usage: node diagnostics/corner-monte-carlo.js [integer-seed] [samples 1..10000]');

const random = mulberry32(seed);
const bounds = {
  rScale: [0.99, 1.01],
  cScale: [PART_LIMITS.timingMlcc.effectiveScale.min, PART_LIMITS.timingMlcc.effectiveScale.max],
  vth: [PART_LIMITS.ao3400a.vgsThreshold.min, PART_LIMITS.ao3400a.vgsThreshold.max],
  leakage: [PART_LIMITS.ao3400a.gateLeakage.min, PART_LIMITS.ao3400a.gateLeakage.max],
  drive: [PART_LIMITS.watchdogLoadedDrive.min, PART_LIMITS.watchdogLoadedDrive.max],
};

function timeout({ rScale, cScale, vth, leakage, drive }) {
  const dt = 10e-3;
  const limit = 35;
  const sim = createStepper([
    { type: 'R', a: 'DRIVE', b: 'GATE', value: 10e6 * rScale, ref: 'R25' },
    { type: 'C', a: 'GATE', b: 'GND', value: 2.2e-6 * cScale, ref: 'C20' },
    { type: 'I', a: 'GATE', b: 'GND', value: leakage, ref: 'Q4~iggs' },
  ], [{ net: 'DRIVE', vf: () => drive }], 'GND', dt);
  for (let step = 0; step <= Math.ceil(limit / dt); step++) {
    const time = step * dt;
    sim.step(time);
    if (sim.vn[sim.ni.GATE] >= vth) return time;
  }
  return Infinity;
}

const fastExtreme = {
  rScale: bounds.rScale[0], cScale: bounds.cScale[0], vth: bounds.vth[0],
  leakage: bounds.leakage[0], drive: bounds.drive[1],
};
const slowExtreme = {
  rScale: bounds.rScale[1], cScale: bounds.cScale[1], vth: bounds.vth[1],
  leakage: bounds.leakage[1], drive: bounds.drive[0],
};
const extreme = { fast: timeout(fastExtreme), slow: timeout(slowExtreme) };

let fastest = { time: Infinity, params: null };
let slowest = { time: -Infinity, params: null };
for (let index = 0; index < samples; index++) {
  const params = Object.fromEntries(Object.entries(bounds).map(([name, [lo, hi]]) => [name, uniform(random, lo, hi)]));
  const time = timeout(params);
  if (time < fastest.time) fastest = { time, params };
  if (time > slowest.time) slowest = { time, params };
}

const fmt = (entry) => ({ seconds: Number(entry.time.toFixed(3)), ...entry.params });
console.log(JSON.stringify({
  seed,
  samples,
  deterministicExtremesSeconds: extreme,
  sampledFastest: fmt(fastest),
  sampledSlowest: fmt(slowest),
}, null, 2));

if (fastest.time < extreme.fast - 1e-12 || slowest.time > extreme.slow + 1e-12)
  throw new Error('a seeded sample escaped the deterministic extreme envelope');
if (fastest.time < 2 || slowest.time > 35)
  throw new Error('a seeded sample escaped the qualified 2..35 s watchdog window');
