import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importNetlist } from '../src/import.js';
import { buildElements, defaultSwitchState, runDC } from '../src/components/index.js';
import { createStepper, gndOf } from '../src/engine.js';
import { CORNERS, PART_LIMITS } from '../src/corners.js';

const netlist = importNetlist();
const ground = gndOf(netlist);
const sources = (pairs) => pairs.map(([net, value]) => ({
  net,
  vf: typeof value === 'function' ? value : () => value,
}));
const currentAt = (sim, ref, pin) => Math.abs(sim.padInjections().find((p) => p.ref === ref && p.pin === pin)?.I || 0);

function measureWatchdog(params, dt = 5e-3, limit = 35) {
  const els = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/DOOR_DRV': 3.3 } },
    params,
  });
  const sim = createStepper(els, sources([['/VBUS', 5], ['/P1', 0], ['/P2', 12]]), ground, dt);
  let madeAt = null;
  let releasedAt = null;
  for (let step = 0; step <= Math.ceil(limit / dt); step++) {
    const time = step * dt;
    sim.step(time);
    const made = Boolean(sim.extractState().ssrs.K2);
    if (madeAt == null && made) madeAt = time;
    if (madeAt != null && !made) {
      releasedAt = time;
      break;
    }
  }
  return { madeAt, releasedAt, state: sim.extractState(), resolvedParams: els.resolvedParams };
}

function measureDoorLead(params, dt = 20e-6, limit = 0.1) {
  const els = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/DOOR_DRV': 3.3 } },
    params,
  });
  const sim = createStepper(els, sources([['/VBUS', 5], ['/P1', 0], ['/P2', 12]]), ground, dt);
  let brokeAt = null;
  let madeAt = null;
  for (let step = 0; step <= Math.ceil(limit / dt); step++) {
    const time = step * dt;
    sim.step(time);
    const { ssrs } = sim.extractState();
    if (brokeAt == null && ssrs.K4) brokeAt = time; // NC K4 opens when its LED operates
    if (madeAt == null && ssrs.K2) {
      madeAt = time;
      break;
    }
  }
  return { brokeAt, madeAt, lead: madeAt - brokeAt };
}

function runPhase({ drive, duration, params, seed, dt = 2e-3 }) {
  const els = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/DOOR_DRV': drive ? 3.3 : 0 } },
    params,
  });
  const sim = createStepper(els, sources([['/VBUS', 5], ['/P1', 0], ['/P2', 12]]), ground, dt, seed);
  for (let time = 0; time < duration; time += dt) sim.step(time);
  return sim.extractState();
}

test('KiCad import preserves exact-part metadata used by corner qualification', () => {
  const byRef = Object.fromEntries(netlist.components.map((component) => [component.ref, component]));
  assert.equal(byRef.C18.fields.MPN, 'CL10A105KB8NNNC');
  assert.equal(byRef.C20.fields.MPN, 'CL10A225KO8NNNC');
  assert.equal(byRef.Q4.fields.MPN, 'AO3400A');
  assert.equal(byRef.K6.fields.MPN, 'GAQY412EH');
  assert.equal(byRef.U1.fields.MPN, 'ESP32-S3-WROOM-1U-N16R8');
  assert.equal(byRef.R25.fields.LCSC, 'C7250');
  assert.match(byRef.C20.datasheet, /CL10A225KO8NNNC/);
});

test('corner overrides are strict and report the resolved nominal/value pair', () => {
  assert.throws(() => buildElements(netlist, { params: { NOT_A_REF: { valueScale: 0.99 } } }), /unknown component NOT_A_REF/);
  assert.throws(() => buildElements(netlist, { params: { R25: { valueScael: 0.99 } } }), /unused simulation parameter.*R25\.valueScael/);

  const els = buildElements(netlist, { params: { R25: { valueScale: 0.99 } } });
  assert.equal(els.find((element) => element.ref === 'R25').value, 9.9e6);
  assert.deepEqual(els.resolvedParams.R25.valueScale, { nominal: 1, value: 0.99 });
});

test('engine surfaces nonlinear non-convergence instead of returning a nominal-looking result', () => {
  const sim = createStepper(
    [{ type: 'D', a: 'N', b: 'GND', Is: 1e-14, n: 1, ref: 'DUT' }],
    sources([['N', 1]]),
    'GND',
    1e-6,
    undefined,
    { maxNewtonIterations: 1 },
  );
  assert.throws(() => sim.step(0), /nonlinear solve did not converge.*at N/);
});

test('PhotoMOS and mechanical-relay models honor guaranteed operate/release delays', () => {
  const dt = 20e-6;
  const ssr = {
    type: 'SSR', a: 'LEDA', b: 'GND', c: 'OUT', d: 'GND', closedWhenOn: false,
    ron: 3, iOperate: 3e-3, iRelease: 0.1e-3, vRelease: 0.5,
    tOperate: 1.5e-3, tRelease: 2e-3, Is: 1e-13, n: 1.9, ref: 'K6',
  };
  const ssrSim = createStepper(
    [ssr, { type: 'R', a: 'VLED', b: 'LEDA', value: 220 }, { type: 'R', a: 'VOUT', b: 'OUT', value: 1000 }],
    sources([['VLED', (time) => time < 4e-3 ? 3.3 : 0], ['VOUT', 5]]),
    'GND', dt,
  );
  let ssrOn = null;
  let ssrOff = null;
  for (let time = 0; time < 8e-3; time += dt) {
    ssrSim.step(time);
    const on = ssrSim.extractState().ssrs.K6;
    if (ssrOn == null && on) ssrOn = time;
    if (ssrOn != null && ssrOff == null && !on) ssrOff = time;
  }
  assert.ok(ssrOn >= 1.45e-3 && ssrOn <= 1.52e-3, `K6 operated at ${ssrOn} s`);
  assert.ok(ssrOff >= 5.95e-3 && ssrOff <= 6.02e-3, `K6 released at ${ssrOff} s`);

  const relay = {
    type: 'RC', a: 'CONTACT', b: 'GND', coilA: 'COIL', coilB: 'GND', nominal: 12,
    pickup: 9.6, release: 1.2, operate: 3e-3, releaseTime: 3e-3, ron: 0.1,
    when: 'on', ref: 'K5',
  };
  const relaySim = createStepper(
    [relay, { type: 'R', a: 'VOUT', b: 'CONTACT', value: 1000 }],
    sources([['COIL', (time) => time < 8e-3 ? 12 : 0], ['VOUT', 5]]),
    'GND', dt,
  );
  let relayOn = null;
  let relayOff = null;
  for (let time = 0; time < 15e-3; time += dt) {
    relaySim.step(time);
    const on = relaySim.extractState().relays.K5;
    if (relayOn == null && on) relayOn = time;
    if (relayOn != null && relayOff == null && !on) relayOff = time;
  }
  assert.ok(relayOn >= 2.95e-3 && relayOn <= 3.02e-3, `K5 operated at ${relayOn} s`);
  assert.ok(relayOff >= 10.95e-3 && relayOff <= 11.02e-3, `K5 released at ${relayOff} s`);
});

test('PhotoMOS actuator fanout operates at minimum rail, maximum LED Vf/R and maximum switch time', () => {
  const els = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/PTT_DRV': 3.3, '/DOOR_DRV': 3.3, '/MUTE_DRV': 3.3 } },
    params: CORNERS.actuatorDrive,
  });
  const sim = createStepper(els, sources([['/VBUS', 5], ['/P1', 0], ['/P2', 12]]), ground, 20e-6);
  for (let time = 0; time < 0.1; time += 20e-6) sim.step(time);
  const { ssrs } = sim.extractState();
  for (const ref of ['K1', 'K2', 'K3', 'K4']) assert.equal(ssrs[ref], true, `${ref} must operate`);
  for (const [ref, min] of [['R4', 2e-3], ['R24', 2e-3], ['R5', 2e-3], ['R21', 3e-3], ['R6', 3e-3]])
    assert.ok(currentAt(sim, ref, '1') > min, `${ref} LED current must exceed ${(min * 1e3).toFixed(1)} mA`);
});

test('DOOR-6 watchdog deterministic fast/nominal/slow corners stay inside the stated window', () => {
  const fast = measureWatchdog(CORNERS.watchdog.fast);
  const nominal = measureWatchdog(CORNERS.watchdog.nominal);
  const slow = measureWatchdog(CORNERS.watchdog.slow);
  for (const [name, result] of Object.entries({ fast, nominal, slow })) {
    assert.notEqual(result.madeAt, null, `${name}: K2 never made`);
    assert.notEqual(result.releasedAt, null, `${name}: K2 did not release inside the qualification window`);
  }
  assert.ok(fast.releasedAt >= 2.0, `fast watchdog ${fast.releasedAt.toFixed(3)} s must exceed 1.75 s + 0.25 s margin`);
  assert.ok(slow.releasedAt <= 35, `slow watchdog ${slow.releasedAt.toFixed(3)} s must remain below 35 s`);
  assert.ok(fast.releasedAt < nominal.releasedAt && nominal.releasedAt < slow.releasedAt,
    `expected ordered corners, got ${fast.releasedAt}/${nominal.releasedAt}/${slow.releasedAt} s`);
  assert.equal(fast.resolvedParams.Q4.vth.value, 0.65);
  assert.equal(slow.resolvedParams.Q4.gateLeakage.value, 100e-9);
});

test('watchdog release time is stable when the transient timestep is refined', () => {
  const coarse = measureWatchdog(CORNERS.watchdog.fast, 5e-3).releasedAt;
  const fine = measureWatchdog(CORNERS.watchdog.fast, 2e-3).releasedAt;
  assert.ok(Math.abs(coarse - fine) <= 8e-3, `watchdog timestep spread ${(coarse - fine) * 1e3} ms is too large`);
});

test('door transfer corners preserve break-before-make and bound the latest make', () => {
  const minimum = measureDoorLead(CORNERS.doorLead.minimumLead);
  const latest = measureDoorLead(CORNERS.doorLead.latestMake);
  assert.ok(minimum.brokeAt < minimum.madeAt, 'K4 must open before K2 closes');
  assert.ok(minimum.lead >= 12e-3, `minimum break lead ${(minimum.lead * 1e3).toFixed(2)} ms must be >=12 ms`);
  assert.ok(latest.madeAt <= 75e-3, `latest K2 make ${(latest.madeAt * 1e3).toFixed(2)} ms must be <=75 ms`);

  const refined = measureDoorLead(CORNERS.doorLead.minimumLead, 10e-6);
  assert.ok(Math.abs(refined.lead - minimum.lead) <= 40e-6,
    `door-lead timestep spread ${Math.abs(refined.lead - minimum.lead) * 1e6} us is too large`);
});

test('500 ms low time re-arms the watchdog even from its fastest-charge corner', () => {
  const charged = runPhase({ drive: true, duration: 2, params: CORNERS.watchdog.fast });
  const rearmed = runPhase({ drive: false, duration: 0.5, params: CORNERS.watchdog.fast, seed: charged });
  assert.ok(rearmed.vn['/WD_GATE'] < 0.5,
    `WD_GATE ${rearmed.vn['/WD_GATE'].toFixed(3)} V must be below the guarded 0.5 V re-arm level`);
});

test('GPIO4/K6 return passes deterministic rail, tolerance, leakage and pin-fault corners', () => {
  const released = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, params: CORNERS.k6.releasedSense, T: 0.06,
  }).V;
  assert.ok(released['/K5_SENSE_N'] > PART_LIMITS.esp32s3.vihMinFractionVdd.value * released['+3V3'],
    `released sense ${released['/K5_SENSE_N'].toFixed(3)} V must exceed VIH`);

  const active = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': (time) => time >= 5e-3 && time < 17e-3 ? 12 : 0 },
    params: CORNERS.k6.activeSense, T: 0.06,
  }).V;
  assert.ok(active['/K5_SENSE_N'] < PART_LIMITS.esp32s3.vilMaxFractionVdd.value * active['+3V3'],
    `active sense ${active['/K5_SENSE_N'].toFixed(3)} V must stay below VIL`);

  const fault = (corner, senseDrive) => {
    const els = buildElements(netlist, {
      switchState: { ...defaultSwitchState(netlist), JP2: false },
      program: { U1: { '/P4_ISO': 3.3, '/K5_SENSE_N': senseDrive } },
      params: corner,
    });
    const sim = createStepper(els, sources([
      ['/VBUS', 5], ['/P1', 0], ['/P2', 12], ['/P4', (time) => time >= 25e-3 ? 12 : 0],
    ]), ground, 20e-6);
    let beforeRing;
    for (let time = 0; time < 60e-3; time += 20e-6) {
      sim.step(time);
      if (!beforeRing && time >= 20e-3)
        beforeRing = { state: sim.extractState(), iLed: currentAt(sim, 'R34', '1') };
    }
    return { sim, beforeRing, end: sim.extractState() };
  };

  const low = fault(CORNERS.k6.gpioStuckLow, 0);
  const vLed = low.beforeRing.state.vn['/K6_A'] - low.beforeRing.state.vn['/K6_RET'];
  const guard = PART_LIMITS.gaqy412eh.temperatureGuard.fraction;
  assert.equal(low.beforeRing.state.ssrs.K6, false, 'stuck-low GPIO must not open K6 before a ring');
  assert.ok(vLed < guard * PART_LIMITS.gaqy412eh.recoveryVoltageMin.value,
    `K6 LED ${vLed.toFixed(3)} V must remain below the guarded recovery voltage`);
  assert.ok(low.beforeRing.iLed < guard * PART_LIMITS.gaqy412eh.recoveryCurrentMin.value,
    `K6 LED ${(low.beforeRing.iLed * 1e6).toFixed(2)} uA must remain below guarded recovery current`);
  assert.ok(low.end.relays.K5 && low.end.ssrs.K6, 'a later ring must still pull K5 and permit K6 isolation');

  const high = fault(CORNERS.k6.gpioStuckHigh, 3.3);
  assert.ok(high.end.relays.K5 && high.end.ssrs.K6, 'stuck-high sense must not defeat normal isolation');
  assert.ok(currentAt(high.sim, 'R34', '1') > PART_LIMITS.gaqy412eh.operateCurrentMax.value,
    'K6 LED current must exceed its maximum operate-current limit at the minimum-drive corner');
  assert.ok(currentAt(high.sim, 'R44', '2') < 50e-6, 'stuck-high GPIO contact current must remain below 50 uA');
});

test('TLP293 sense remains digital-valid at minimum CTR and maximum hot dark current', () => {
  const hot = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P4': 7 }, params: CORNERS.optocoupler.hotLeakage, T: 0.05,
  }).V;
  assert.ok(hot['/P4_SENSE_N'] < PART_LIMITS.esp32s3.vilMaxFractionVdd.value * hot['+3V3']);

  const dark = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P4': 0 }, params: CORNERS.optocoupler.dark, T: 0.05,
  }).V;
  assert.ok(dark['/P4_SENSE_N'] > PART_LIMITS.esp32s3.vihMinFractionVdd.value * dark['+3V3']);
});

test('post-fuse voltage monitor remains bounded across 1% divider and ESP leakage corners', () => {
  const high = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 }, params: CORNERS.powerMonitor.highReading }).V;
  const low = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 }, params: CORNERS.powerMonitor.lowReading }).V;
  assert.ok(high['/VBUS_F_ADC'] > low['/VBUS_F_ADC'], 'named high/low monitor corners must order correctly');
  assert.ok(low['/VBUS_F_ADC'] > 0.40 && high['/VBUS_F_ADC'] < 0.47,
    `monitor corner range ${low['/VBUS_F_ADC'].toFixed(3)}-${high['/VBUS_F_ADC'].toFixed(3)} V is unexpected`);
});

test('audio receive divider gain remains bounded at resistor and coupling-cap corners', () => {
  const gain = (params) => {
    const result = runDC(netlist, {
      sources: { '/VBUS': 5, '/P1': 0, '/P2': (time) => Math.sin(2 * Math.PI * 1000 * time) },
      params, T: 10e-3, dt: 5e-6,
    }).RES;
    const start = Math.floor(result.t.length / 2);
    const diff = result.v['/ES_MICP'].slice(start).map((value, index) => value - result.v['/ES_VMID'][start + index]);
    return (Math.max(...diff) - Math.min(...diff)) / 2; // input amplitude is 1 V
  };
  const high = gain(CORNERS.audioReceive.highGain);
  const low = gain(CORNERS.audioReceive.lowGain);
  assert.ok(high > low, `audio high corner ${high} must exceed low corner ${low}`);
  assert.ok(low > 0.12 && high < 0.14, `audio receive gain ${low.toFixed(3)}-${high.toFixed(3)} must remain near -18 dB`);
});

test('fitted 0466 fuse uses its real resistance and nominal melting I2t', () => {
  const fuse = buildElements(netlist).find((element) => element.ref === 'F1');
  assert.equal(fuse.ron, PART_LIMITS.fuse0466001.coldResistanceNominal.value);
  assert.equal(fuse.i2t, PART_LIMITS.fuse0466001.meltingI2tNominal.value);
});
