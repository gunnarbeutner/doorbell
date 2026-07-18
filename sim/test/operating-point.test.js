import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStepper } from '../src/engine.js';

const sources = [
  { net: 'P2', vf: () => 12 },
  { net: 'CODEC', vf: () => 1.65 },
];

function prechargeStepper(prechargeResistance) {
  return createStepper([
    { type: 'R', a: 'P2', b: 'TALK_BRIDGE', value: prechargeResistance, ref: 'PRECHARGE' },
    { type: 'C', a: 'CODEC_SIDE', b: 'TALK_BRIDGE', value: 1e-6, ref: 'C14' },
    { type: 'R', a: 'CODEC', b: 'CODEC_SIDE', value: 2.2e3, ref: 'R26' },
  ], sources, 'GND', 10e-3);
}

test('DC operating point, not elapsed-time guess, gates fast-forward for RC precharge', () => {
  for (const resistance of [200e3, 2e6]) {
    const sim = prechargeStepper(resistance);
    sim.step(0);
    const target = sim.operatingPoint(0);

    assert.ok(Math.abs(target.state.vn.TALK_BRIDGE - 12) < 1e-3,
      `${resistance} Ω precharge must have a 12 V DC target`);
    assert.equal(sim.atOperatingPoint(target), false,
      'an initially uncharged coupling capacitor is not at its DC operating point');

    let time = 0;
    let steps = 0;
    while (!sim.atOperatingPoint(target) && steps < 5000) {
      time += 10e-3;
      sim.step(time);
      steps++;
    }

    assert.ok(steps < 5000, `${resistance} Ω precharge did not converge to its solved operating point`);
    assert.ok(sim.vn[sim.ni.TALK_BRIDGE] > 11.98,
      `fast-forward gate accepted ${sim.vn[sim.ni.TALK_BRIDGE].toFixed(4)} V instead of the 12 V target`);
  }
});

test('the former 140 ms TALK_BRIDGE value is explicitly not settled', () => {
  const sim = prechargeStepper(200e3);
  const target = sim.operatingPoint(0);
  for (let step = 0; step <= 14; step++) sim.step(step * 10e-3);

  const talkBridge = sim.vn[sim.ni.TALK_BRIDGE];
  assert.ok(talkBridge > 6 && talkBridge < 8,
    `expected the incomplete precharge near 6.8 V, got ${talkBridge.toFixed(3)} V`);
  assert.equal(sim.atOperatingPoint(target), false,
    'the incomplete 140 ms precharge must never authorize fast-forward');
});
