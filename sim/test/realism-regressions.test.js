import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importNetlist } from '../src/import.js';
import { buildElements, defaultSwitchState, runDC } from '../src/components/index.js';
import { createStepper, gndOf } from '../src/engine.js';
import { CORNERS, PART_LIMITS } from '../src/corners.js';
import { NEIGHBOUR_RING_GONG, OWN_RING_ONSET } from '../test-support/fixtures/captured-waveforms.js';

const netlist = importNetlist();
const ground = gndOf(netlist);
const sourceList = (values) => Object.entries(values).map(([net, value]) => ({
  net,
  vf: typeof value === 'function' ? value : () => value,
}));
const voltage = (sim, net) => sim.vn[sim.ni[net]] ?? 0;
const stepFor = (sim, duration, dt) => {
  for (let time = 0; time < duration; time += dt) sim.step(time);
};
const span = (values, start = 0) => {
  const slice = values.slice(start);
  return Math.max(...slice) - Math.min(...slice);
};

test('SAFE-7 fuse survives normal startup, blows on a downstream short, and stays latched open', () => {
  const cable = { type: 'R', a: '/USB_SOURCE', b: '/VBUS', value: 0.25, ref: 'USB cable' };
  const supplies = sourceList({ '/USB_SOURCE': 5, '/P1': 0 });

  const normalElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    extra: [cable],
  });
  const normalFuse = normalElements.find((element) => element.ref === 'F1');
  const normal = createStepper(normalElements, supplies, ground, 20e-6);
  stepFor(normal, 20e-3, 20e-6);
  assert.equal(normalFuse.blown, false, 'normal board startup/load must not blow F1');
  assert.ok(normalFuse.melt < 0.1 * normalFuse.i2t,
    `startup inrush must use under 10% of nominal melting I²t, got ${normalFuse.melt.toExponential(3)} A²s`);
  assert.ok(voltage(normal, '+3V3') > 3.2, 'the intact-fuse control must power the logic rail');

  const faultElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    extra: [cable, { type: 'R', a: '+5V', b: 'GND', value: 0.25, ref: 'downstream short' }],
  });
  const faultFuse = faultElements.find((element) => element.ref === 'F1');
  const fault = createStepper(faultElements, supplies, ground, 10e-6);
  let blownAt = null;
  for (let step = 0; step < 1000; step++) {
    const time = step * 10e-6;
    fault.step(time);
    if (blownAt == null && faultFuse.blown) blownAt = time;
  }
  assert.notEqual(blownAt, null, 'the representative post-fuse short must melt F1');
  assert.ok(blownAt < 5e-3, `the simplified I²t model should isolate this severe short promptly, got ${blownAt} s`);
  assert.ok(faultFuse.melt >= faultFuse.i2t, 'the fuse must open only after its melting-I²t threshold');
  assert.equal(faultFuse.icur, 0, 'an opened fuse must carry no downstream fault current');
  assert.ok(voltage(fault, '+5V') < 0.05 && voltage(fault, '+3V3') < 0.05,
    `post-fuse rails must collapse, got +5V=${voltage(fault, '+5V').toFixed(3)} V / +3V3=${voltage(fault, '+3V3').toFixed(3)} V`);

  const isolatedElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    extra: [cable],
  });
  const isolatedFuse = isolatedElements.find((element) => element.ref === 'F1');
  const isolated = createStepper(isolatedElements, supplies, ground, 20e-6, fault.extractState());
  stepFor(isolated, 5e-3, 20e-6);
  assert.equal(isolatedFuse.blown, true, 'removing the short must not heal a melted fuse');
  assert.ok(voltage(isolated, '+5V') < 0.05 && voltage(isolated, '+3V3') < 0.05,
    'the latched-open fuse must keep the board isolated after the fault is removed');
  assert.ok(Math.abs((5 - voltage(isolated, '/VBUS')) / cable.value) < 1e-6,
    'a blown F1 must unload the upstream USB source');
});

test('SAFE-6 powered boot and brownout return every smart actuator to its passive state', () => {
  const bootElements = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const boot = createStepper(bootElements, sourceList({ '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 0 }), ground, 20e-6);
  stepFor(boot, 10e-3, 20e-6);
  const bootState = boot.extractState();
  for (const ref of ['K1', 'K2', 'K3', 'K4', 'K6'])
    assert.equal(bootState.ssrs[ref], false, `${ref} must be LED-off/passive with powered but floating GPIOs`);
  for (const net of ['/PTT_DRV', '/DOOR_DRV', '/MUTE_DRV', '/P4_ISO'])
    assert.ok(Math.abs(bootState.vn[net]) < 0.05, `${net} must be held inactive at powered boot`);
  assert.ok(Math.abs(bootState.vn['/P3']) < 1, 'powered boot must not create the P2↔P3 door bridge');

  const releaseParams = {
    K1: { tRelease: PART_LIMITS.gaqw212gs.releaseTimeMax.value },
    K2: { tRelease: PART_LIMITS.gaqy212gs.releaseTimeMax.value },
    K3: { tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value },
    K4: { tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value },
    K6: { tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value },
  };
  const activeElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/PTT_DRV': 3.3, '/DOOR_DRV': 3.3, '/MUTE_DRV': 3.3, '/P4_ISO': 3.3 } },
    params: releaseParams,
  });
  const active = createStepper(activeElements,
    sourceList({ '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }), ground, 20e-6);
  stepFor(active, 0.1, 20e-6);
  const activeState = active.extractState();
  for (const ref of ['K1', 'K2', 'K3', 'K4', 'K6'])
    assert.equal(activeState.ssrs[ref], true, `${ref} must be active before the brownout test`);

  // Rebuilding without the MCU drivers represents reset/brownout: physical C/relay/SSR/fuse state is
  // retained, but VBUS and every GPIO drive disappear together.
  const brownoutElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    params: releaseParams,
  });
  const brownout = createStepper(brownoutElements,
    sourceList({ '/P1': 0, '/P2': 12, '/P4': 12 }), ground, 20e-6, activeState);
  const releasedAt = {};
  for (let step = 0; step < 500; step++) {
    const time = step * 20e-6;
    brownout.step(time);
    const state = brownout.extractState();
    for (const ref of ['K1', 'K2', 'K3', 'K4', 'K6'])
      if (releasedAt[ref] == null && !state.ssrs[ref]) releasedAt[ref] = time;
  }
  const fastLimit = PART_LIMITS.gaqw212gs.releaseTimeMax.value + 20e-6;
  for (const ref of ['K1', 'K2'])
    assert.ok(releasedAt[ref] <= fastLimit, `${ref} brownout release ${releasedAt[ref]} s exceeds ${fastLimit} s`);
  const ncLimit = PART_LIMITS.gaqy412eh.releaseTimeMax.value + 20e-6;
  for (const ref of ['K3', 'K4', 'K6'])
    assert.ok(releasedAt[ref] <= ncLimit, `${ref} brownout release ${releasedAt[ref]} s exceeds ${ncLimit} s`);
  const safe = brownout.extractState();
  assert.ok(Math.abs(safe.vn['/P3']) < 1, 'brownout must remove the door bridge');
  assert.ok(safe.vn['+3V3'] < 0.05, 'the logic rail must collapse rather than phantom-powering GPIO drives');
});

test('K5 loss restores the full K5-to-K6 raw-P4 chain inside the combined maximum release time', () => {
  const dt = 20e-6;
  const p2Fall = 40e-3;
  const elements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/P4_ISO': 3.3 } },
    params: {
      K5: { releaseTime: PART_LIMITS.g6k2fYDc12.releaseTimeMax.value },
      K6: { tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value },
    },
  });
  const sim = createStepper(elements, sourceList({
    '/VBUS': 5,
    '/P1': 0,
    '/P2': (time) => time < p2Fall ? 12 : 0,
    '/P4': (time) => time >= 5e-3 && time < 17e-3 ? 12 : time >= p2Fall ? 1 : 0,
  }), ground, dt);
  let k5ReleasedAt = null;
  let k6ReleasedAt = null;
  let contactRestoredAt = null;
  for (let step = 0; step < 3000; step++) {
    const time = step * dt;
    sim.step(time);
    const state = sim.extractState();
    if (time >= p2Fall && k5ReleasedAt == null && !state.relays.K5) k5ReleasedAt = time;
    if (k5ReleasedAt != null && k6ReleasedAt == null && !state.ssrs.K6) k6ReleasedAt = time;
    if (k6ReleasedAt != null && contactRestoredAt == null && Math.abs(state.vn['/K5_LATCH'] - state.vn['/P4']) < 0.01)
      contactRestoredAt = time;
  }
  assert.ok(k5ReleasedAt <= p2Fall + PART_LIMITS.g6k2fYDc12.releaseTimeMax.value + dt,
    `K5 released too late at ${k5ReleasedAt} s`);
  assert.ok(k6ReleasedAt - k5ReleasedAt <= PART_LIMITS.gaqy412eh.releaseTimeMax.value + dt,
    `K6 took ${k6ReleasedAt - k5ReleasedAt} s after K5 loss to recover`);
  assert.ok(contactRestoredAt - k6ReleasedAt <= dt,
    'K6 NC must reconnect raw P4 to K5_LATCH on the first solved step after recovery');
});

test('bounded P2-P5 polarity faults are current-limited, clamped, and contained from other bus lines', () => {
  const lines = ['/P2', '/P3', '/P4', '/P5'];
  const sourceResistance = 2000;
  const ramp = (level) => (time) => time < 1e-3 ? 0 : time < 2e-3 ? level * (time - 1e-3) / 1e-3 : level;
  const maxAbs = (values, start = 0) => Math.max(...values.slice(start).map(Math.abs));
  for (const line of lines) for (const level of [-50, 50]) {
    const fault = ramp(level);
    const { RES } = runDC(netlist, {
      sources: { '/VBUS': 5, '/P1': 0, '/FAULT': fault },
      extra: [{ type: 'R', a: '/FAULT', b: line, value: sourceResistance, ref: `fault limiter ${line}` }],
      T: 6e-3,
      dt: 10e-6,
    });
    const start = RES.t.findIndex((time) => time >= 1e-3);
    const terminalPeak = maxAbs(RES.v[line], start);
    assert.ok(terminalPeak < 40,
      `${line} ${level} V fault must clamp below 40 V, got ${terminalPeak.toFixed(2)} V`);
    const currentPeak = Math.max(...RES.t.slice(start).map((time, index) =>
      Math.abs((fault(time) - RES.v[line][start + index]) / sourceResistance)));
    assert.ok(currentPeak < 30e-3,
      `${line} ${level} V fault current must stay below 30 mA, got ${(currentPeak * 1e3).toFixed(2)} mA`);
    const otherPeak = Math.max(...lines.filter((other) => other !== line).map((other) => maxAbs(RES.v[other], start)));
    assert.ok(otherPeak < 2,
      `${line} ${level} V fault must not drive another bus line above 2 V, got ${otherPeak.toFixed(2)} V`);
    assert.ok(maxAbs(RES.v['+3V3'], start) <= 3.6 && maxAbs(RES.v['+5V'], start) <= 5.1,
      `${line} ${level} V fault must not overdrive the powered rails`);
    for (const net of ['/ES_MICP', '/ES_MICN', '/ES_OUTP', '/P4_SENSE_N', '/P5_SENSE_N']) {
      const values = RES.v[net].slice(start);
      assert.ok(Math.min(...values) >= -0.3 && Math.max(...values) <= 3.6,
        `${line} ${level} V fault drove ${net} outside the protected logic/codec envelope`);
    }
    const optoCurrent = Math.max(maxAbs(RES.v['/OC1_K'], start), maxAbs(RES.v['/OC2_K'], start)) / 5100;
    const rxCurrent = maxAbs(RES.v['/ES_MICP_AC'].map((value, index) => value - RES.v['/ES_MICP'][index]), start) / 22000;
    assert.ok(optoCurrent < 10e-3 && rxCurrent < 10e-3,
      `${line} ${level} V fault must remain below the 10 mA qualification currents of the protected taps`);
  }
});

test('LDO model is one-quadrant: it regulates normally but neither back-drives nor sinks an overdriven output', () => {
  const circuit = (extra = []) => [{
    type: 'LDO', vin: 'VIN', vout: 'VOUT', gnd: 'GND', vreg: 3.3, drop: 0.3,
    ref: 'DUT', pinVin: '1', pinVout: '2',
  }, {
    type: 'R', a: 'VIN', b: 'GND', value: 1000, ref: 'VIN load',
  }, {
    type: 'R', a: 'VOUT', b: 'GND', value: 330, ref: 'VOUT load',
  }, ...extra];
  const settle = (elements, sources) => {
    const sim = createStepper(elements, sourceList(sources), 'GND', 10e-6);
    stepFor(sim, 1e-3, 10e-6);
    return sim;
  };

  const normalElements = circuit();
  const normal = settle(normalElements, { VIN: 5 });
  assert.ok(Math.abs(voltage(normal, 'VOUT') - 3.3) < 1e-3, 'a supplied LDO must regulate its load');
  assert.equal(normal.extractState().ldos.DUT, true);
  assert.ok(normalElements[0].icur > 9e-3, 'normal regulation must source the output load from VIN');

  const forcedOutput = { type: 'R', a: 'FORCE', b: 'VOUT', value: 10, ref: 'forced output' };
  const deadElements = circuit([forcedOutput]);
  const dead = settle(deadElements, { FORCE: 3.3 });
  assert.equal(dead.extractState().ldos.DUT, false, 'dead VIN must leave the regulator pass element off');
  assert.ok(Math.abs(voltage(dead, 'VIN')) < 1e-6, 'an externally raised VOUT must not back-drive VIN');
  assert.equal(deadElements[0].icur, 0, 'the dead regulator must carry no pass current');

  const overdrivenElements = circuit([forcedOutput]);
  const overdriven = settle(overdrivenElements, { VIN: 5, FORCE: 4 });
  assert.equal(overdriven.extractState().ldos.DUT, false, 'an overdriven output must release regulation');
  assert.ok(voltage(overdriven, 'VOUT') > 3.6, 'the test source must demonstrably overdrive VOUT');
  assert.equal(overdrivenElements[0].icur, 0, 'the LDO model must not sink the forced output into VIN');
});

test('audio transmit coupling remains present and bounded across the voice band and component corners', () => {
  const frequencies = [300, 1000, 3400];
  const measure = (params, frequency) => {
    const out = (time) => 1.65 + 0.4 * Math.sin(2 * Math.PI * frequency * time);
    const RES = runDC(netlist, {
      sources: { '/VBUS': 5, '/P1': 0, '/P2~bus': 12 },
      extra: [{ type: 'R', a: '/P2~bus', b: '/P2', value: 90, ref: 'measured bus source Z' }],
      program: { U1: { '/PTT_DRV': 3.3 }, U3: { out } },
      params,
      T: Math.max(12 / frequency, 8e-3),
      dt: 1 / (frequency * 64),
    }).RES;
    const start = Math.floor(RES.t.length / 2);
    const p3 = RES.v['/P3'].map((value, index) => value - RES.v['/P1'][index]);
    const codec = RES.v['/ES_OUTP'].map((value, index) => value - RES.v.GND[index]);
    return span(p3, start) / span(codec, start);
  };
  const high = frequencies.map((frequency) => measure(CORNERS.audioTransmit.highCoupling, frequency));
  const low = frequencies.map((frequency) => measure(CORNERS.audioTransmit.lowCoupling, frequency));
  for (let index = 0; index < frequencies.length; index++) {
    assert.ok(high[index] > low[index],
      `${frequencies[index]} Hz high-coupling TX corner must exceed the low corner`);
    assert.ok(low[index] > 0.02 && high[index] < 0.2,
      `${frequencies[index]} Hz TX gain ${low[index].toFixed(3)}-${high[index].toFixed(3)} is outside the qualified envelope`);
  }
  assert.ok(Math.max(...high) / Math.min(...low) < 5,
    `voice-band TX corner spread must remain below 5x, got ${(Math.max(...high) / Math.min(...low)).toFixed(2)}x`);

  const dcLevel = (codecLevel) => runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2~bus': 12 },
    extra: [{ type: 'R', a: '/P2~bus', b: '/P2', value: 90, ref: 'measured bus source Z' }],
    program: { U1: { '/PTT_DRV': 3.3 }, U3: { out: codecLevel } },
    T: 30e-3,
  }).V['/P3'];
  assert.ok(Math.abs(dcLevel(0.8) - dcLevel(2.5)) < 0.02,
    'C14 must block codec DC bias changes from shifting the talk-line pedestal');
});

const capturedWave = (fixture, channel) => (time) => {
  const values = fixture[channel];
  const position = Math.max(0, Math.min(values.length - 1, time / fixture.dt));
  const index = Math.floor(position);
  const fraction = position - index;
  return values[index] + fraction * ((values[index + 1] ?? values[index]) - values[index]);
};

const replayCapture = (fixture) => {
  const dt = fixture.dt;
  const elements = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const sim = createStepper(elements, sourceList({
    '/VBUS': 5,
    '/P1': 0,
    '/P2': capturedWave(fixture, 'p2'),
    '/P4': capturedWave(fixture, 'p4'),
  }), ground, dt);
  const observed = { k5: false, p4Sense: [], speaker: [], mic: [] };
  for (let step = 0; step < fixture.p2.length; step++) {
    sim.step(step * dt);
    const state = sim.extractState();
    observed.k5 ||= Boolean(state.relays.K5);
    observed.p4Sense.push(state.vn['/P4_SENSE_N']);
    observed.speaker.push(state.vn['/P5'] - (state.vn.GND || 0));
    observed.mic.push(state.vn['/ES_MICP'] - state.vn['/ES_MICN']);
  }
  return observed;
};

const longestLowRun = (values, threshold, dt) => {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    current = value < threshold ? current + dt : 0;
    longest = Math.max(longest, current);
  }
  return longest;
};

test('captured own-ring onset asserts Türruf sense and reaches the passive gong', () => {
  const observed = replayCapture(OWN_RING_ONSET);
  assert.ok(longestLowRun(observed.p4Sense, 0.825, OWN_RING_ONSET.dt) > 20e-3,
    'the measured DC pedestal must produce a sustained valid active-low Türruf sense');
  assert.ok(span(observed.speaker, observed.speaker.length >> 1) > 0.5,
    'the measured gong waveform must reach the passive speaker path');
});

test('captured neighbour gong reaches RX without false local-P4 detection or K5 pull-in', () => {
  const observed = replayCapture(NEIGHBOUR_RING_GONG);
  assert.equal(observed.k5, false, 'a measured neighbour gong must not pull this handset\'s K5');
  assert.ok(longestLowRun(observed.p4Sense, 0.825, NEIGHBOUR_RING_GONG.dt) < 50e-3,
    'captured DC-free P4 crosstalk must not sustain the 50 ms local-ring qualification interval');
  assert.ok(span(observed.mic, observed.mic.length >> 1) > 0.02,
    'the measured shared-P2 neighbour gong must reach the codec RX tap');
});

test('DOOR-3: both K1 contacts welded closed retain the 2.2 kΩ talk signature and cannot mimic K2', () => {
  const byRef = Object.fromEntries(netlist.components.map((component) => [component.ref, component]));
  assert.equal(byRef.R28.value, '2.2kΩ', 'the passive talk bridge must remain 2.2 kΩ');
  const load = { type: 'R', a: '/P3', b: 'GND', value: 1000, ref: 'TV20/S discriminator load' };
  const welds = [
    { type: 'R', a: '/P2', b: '/TALK_BRIDGE', value: 0.1, ref: 'K1 ch1 welded' },
    { type: 'R', a: '/TX_OUT', b: '/P3', value: 0.1, ref: 'K1 ch2 welded' },
  ];
  const weldedElements = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    extra: [load, ...welds],
  });
  const welded = createStepper(weldedElements, sourceList({ '/P1': 0, '/P2': 12 }), ground, 20e-6);
  stepFor(welded, 50e-3, 20e-6);
  const p3 = voltage(welded, '/P3');
  const bridgeResistance = (12 - p3) / (p3 / load.value);
  assert.ok(bridgeResistance > 2000 && bridgeResistance < 2400,
    `the double-weld fault must still look like talk, got ${bridgeResistance.toFixed(1)} Ω`);
  assert.ok(p3 < 6, `the loaded welded-talk path must stay distinct from a door short, got P3=${p3.toFixed(2)} V`);
  assert.equal(welded.extractState().relays.K5, false, 'a welded K1 must not create a K5 session');

  const door = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 },
    program: { U1: { '/DOOR_DRV': 3.3 } },
    extra: [load],
    T: 0.1,
  }).V['/P3'];
  const doorResistance = (12 - door) / (door / load.value);
  assert.ok(door > 11 && doorResistance < 100,
    `the K2 control must retain a distinct near-short signature, got ${doorResistance.toFixed(1)} Ω`);
});
