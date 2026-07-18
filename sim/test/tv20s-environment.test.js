import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FirmwareCircuitRunner, HeadCircuitFixture } from '../firmware-test/circuit-runner.js';
import { importNetlist } from '../src/import.js';
import { TV20S_CALIBRATION, TV20S_EVIDENCE, validateTv20sCalibration } from '../src/tv20s/calibration.js';
import { Tv20sEnvironment, UnsupportedTv20sBehavior } from '../src/tv20s/environment.js';

const repo = new URL('../../', import.meta.url);
const sha256 = (url) => createHash('sha256').update(readFileSync(url)).digest('hex');

test('TV20/S calibration is schema-valid and tied to unchanged capture evidence', () => {
  assert.equal(validateTv20sCalibration(), true);
  for (const capture of Object.values(TV20S_EVIDENCE.captures)) {
    for (const [name, expected] of Object.entries(capture.files)) {
      const url = new URL(`captures/runs/${capture.run}/${name}`, repo);
      assert.equal(sha256(url), expected, `${capture.run}/${name} changed without recalibrating the TV20/S model`);
    }
  }
});

test('TV20/S core observes only terminal voltages, never DUT implementation state', () => {
  const source = readFileSync(new URL('../src/tv20s/environment.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /state\.(?:relays|ssrs)|mediaActive|switches\?\./,
    'the environment must not inspect DUT relays, SSRs, switches, or firmware/media state');
});

test('calibrated terminal equivalents reproduce the captured DC operating envelopes', () => {
  const c = TV20S_CALIBRATION;
  const oneCoil = c.p2.idle_v / (1 + c.p2.source_resistance_ohm / 320);
  assert.ok(oneCoil >= c.p2.single_session_observed_v[0] && oneCoil <= c.p2.single_session_observed_v[1],
    `one-coil P2=${oneCoil.toFixed(3)} V is outside the captured session envelope`);

  const idleDoor = c.p2.idle_v * c.p3.door_idle_sink_ohm /
    (c.p2.source_resistance_ohm + c.p3.door_idle_sink_ohm);
  assert.ok(idleDoor >= c.p3.door_idle_observed_v[0] && idleDoor <= c.p3.door_idle_observed_v[1],
    `idle door meet=${idleDoor.toFixed(3)} V is outside the captured envelope`);

  const heldDoor = c.p2.idle_v /
    (1 + c.p2.source_resistance_ohm / 320 + c.p2.source_resistance_ohm / c.p3.door_session_sink_ohm);
  assert.ok(heldDoor >= c.p3.door_session_observed_v[0] && heldDoor <= c.p3.door_session_observed_v[1],
    `held door meet=${heldDoor.toFixed(3)} V is outside the captured envelope`);
});

test('synthetic TV20/S own ring pulls in the live HEAD passive latch', () => {
  const fixture = new HeadCircuitFixture({ environment: 'tv20s' });
  fixture.advanceTo(100);
  fixture.applyEvent({ type: 'environment', action: 'own-ring', at: 100 });
  while (fixture.nowMs < 130) fixture.advanceTo(130);
  const sample = fixture.snapshot();
  assert.equal(sample.relays.K5, true);
  assert.equal(sample.environment.callOwner, 'local');
  assert.equal(sample.environment.phase, 'ring-gong');
  assert.ok(sample.voltages['/P4'] > 9, `synthetic ring P4=${sample.voltages['/P4'].toFixed(3)} V`);

  fixture.applyEvent({ type: 'environment', action: 'timeout-now', at: 130 });
  while (fixture.nowMs < 180) fixture.advanceTo(180);
  const timedOut = fixture.snapshot();
  assert.equal(timedOut.relays.K5, false, 'the captured P2 timeout waveform must release HEAD K5 electrically');
  assert.equal(timedOut.environment.callOwner, null);
});

test('synthetic neighbour is the live WF26 topology and does not assert local P4', () => {
  const fixture = new HeadCircuitFixture({ environment: 'tv20s' });
  fixture.advanceTo(100);
  fixture.applyEvent({ type: 'environment', action: 'neighbour-ring', at: 100 });
  while (fixture.nowMs < 200) fixture.advanceTo(200);
  const sample = fixture.snapshot();
  assert.equal(sample.relays.TV20S_NEIGHBOUR_WF26_K1, true);
  assert.equal(sample.relays.K5, false);
  assert.ok(Math.abs(sample.voltages['/P4']) < 1, `private neighbour ring leaked DC onto local P4`);

  const gong = [];
  for (let at = 200; at <= 400; at += 0.1) {
    while (fixture.nowMs < at) fixture.advanceTo(at);
    gong.push(fixture.voltage('/P2'));
  }
  const mean = gong.reduce((sum, value) => sum + value, 0) / gong.length;
  const rms = Math.sqrt(gong.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gong.length);
  assert.ok(mean >= TV20S_CALIBRATION.p2.single_session_observed_v[0] &&
    mean <= TV20S_CALIBRATION.p2.single_session_observed_v[1],
  `synthetic neighbour P2 mean ${mean.toFixed(3)} V is outside the captured session envelope`);
  assert.ok(rms >= TV20S_CALIBRATION.ring.p2_gong_observed_rms_v[0] &&
    rms <= TV20S_CALIBRATION.ring.p2_gong_observed_rms_v[1],
  `synthetic P2 gong ${rms.toFixed(3)} Vrms is outside the captured envelope`);
});

test('synthetic direct door reproduces the captured P2-P3 meet and recovery', () => {
  const fixture = new HeadCircuitFixture({ environment: 'tv20s' });
  fixture.advanceTo(100);
  fixture.setOutput('DOOR_DRV', true, 100);
  while (fixture.nowMs < 180) fixture.advanceTo(180);
  let sample = fixture.snapshot();
  assert.equal(sample.ssrs.K2, true);
  assert.equal(sample.environment.phase, 'door');
  assert.ok(sample.voltages['/P3'] >= TV20S_CALIBRATION.p3.door_idle_observed_v[0] &&
    sample.voltages['/P3'] <= TV20S_CALIBRATION.p3.door_idle_observed_v[1],
  `door meet P3=${sample.voltages['/P3'].toFixed(3)} V is outside the captured envelope`);

  fixture.setOutput('DOOR_DRV', false, 180);
  while (fixture.nowMs < 200) fixture.advanceTo(200);
  sample = fixture.snapshot();
  assert.equal(sample.ssrs.K2, false);
  assert.ok(Math.abs(sample.voltages['/P3']) < 0.1, `released P3=${sample.voltages['/P3'].toFixed(3)} V`);
  assert.ok(sample.voltages['/P2'] > 7.1 && sample.voltages['/P2'] < TV20S_CALIBRATION.p2.idle_v,
    `P2 must be in its measured post-door recovery, got ${sample.voltages['/P2'].toFixed(3)} V`);
});

test('direct door during an own gong composes the calibrated ring and door terminal equivalents', () => {
  const environment = new Tv20sEnvironment({ referenceNetlist: importNetlist('wf26') });
  environment.apply('own-ring', 0);
  assert.equal(environment.observe({ nowMs: 1900,
    voltage: (net) => net === '/P2' ? 9.19 : net === '/P3' ? 9.18 : 0 }), true);
  assert.equal(environment.snapshot(1900).phase, 'door');

  assert.equal(environment.observe({ nowMs: 1901,
    voltage: (net) => net === '/P2' ? 2.5 : net === '/P3' ? 2.49 : 0 }), false);
  assert.equal(environment.snapshot(1901).directDoor, true,
    'gong excursions must not look like a released physical P2-P3 bridge');
});

test('floor-call and timeout sources use captured timing and amplitudes', () => {
  const environment = new Tv20sEnvironment({ referenceNetlist: importNetlist('wf26') });
  environment.apply('floor-call-start', 100);
  const floorSamples = Array.from({ length: 2000 }, (_, index) => environment.floorAt(100 + index / 10));
  assert.ok(Math.max(...floorSamples) > 0 && Math.min(...floorSamples) < 0,
    'floor call must be a bipolar, DC-free waveform');

  const fixture = new HeadCircuitFixture({ environment: 'tv20s' });
  fixture.applyEvent({ type: 'environment', action: 'floor-call-start', at: 0 });
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let at = 0.1; at <= 10; at += 0.1) {
    while (fixture.nowMs < at) fixture.advanceTo(at);
    minimum = Math.min(minimum, fixture.voltage('/P5'));
    maximum = Math.max(maximum, fixture.voltage('/P5'));
  }
  assert.ok(maximum >= 7.5 && maximum <= TV20S_CALIBRATION.floor_call.terminal_robust_v[1] + 0.1,
    `synthetic P5 positive peak ${maximum.toFixed(3)} V misses the captured robust peak`);
  assert.ok(minimum >= TV20S_CALIBRATION.floor_call.terminal_raw_v[0] && minimum < 0,
    `synthetic P5 negative peak ${minimum.toFixed(3)} V exceeds the captured raw range`);

  environment.apply('floor-call-stop', 400);
  environment.apply('own-ring', 500);
  environment.apply('timeout-now', 5000);
  assert.equal(environment.p2SourceAt(5000), TV20S_CALIBRATION.p2.timeout_terminal_start_v);
  assert.equal(environment.p2SourceAt(5030), TV20S_CALIBRATION.p2.timeout_terminal_plateau_v);
  assert.ok(environment.p2SourceAt(5050) > TV20S_CALIBRATION.p2.timeout_recovery_snap_v &&
    environment.p2SourceAt(5050) < TV20S_CALIBRATION.p2.idle_v,
  'timeout recovery must be derived from virtual elapsed time');
});

test('paused TV20/S actions do not mutate the circuit until virtual time advances', () => {
  const runner = new FirmwareCircuitRunner({ interactive: true,
    fixtureOptions: { environment: 'tv20s' } });
  const before = runner.fixture.snapshot();
  const writes = [];
  runner.socket = { write(value) { writes.push(value); } };
  runner.pendingAdvance = { now: 0, deadline: 5000 };

  runner.queueEnvironmentAction('own-ring');
  runner.drainInteractive();
  assert.deepEqual(runner.fixture.snapshot(), before);
  assert.deepEqual(writes, []);

  runner.setHorizon(1);
  const after = runner.fixture.snapshot();
  assert.equal(after.at, 1);
  assert.equal(after.environment.callOwner, 'local');
  assert.notEqual(after.voltages['/P4'], before.voltages['/P4']);
});

test('unsupported TV20/S compositions fail with a structured evidence request', () => {
  const environment = new Tv20sEnvironment({ referenceNetlist: importNetlist('wf26') });
  environment.apply('own-ring', 0);
  assert.throws(() => environment.apply('floor-call-start', 10), (error) =>
    Boolean(error instanceof UnsupportedTv20sBehavior && error.code === 'overlapping-bell-types' && error.neededEvidence));
  assert.equal(environment.observe({ nowMs: 20,
    voltage: (net) => net === '/P2' ? 9.37 : net === '/P3' ? 0.99 : 0 }), true);
  assert.equal(environment.snapshot(20).talk, true, 'the stock 2.2 kΩ handshake is a supported state');
  assert.throws(() => environment.observe({ nowMs: 30,
    voltage: (net) => net === '/P2' ? 9.37 : net === '/P3' ? 2 : 0 }), (error) =>
    error instanceof UnsupportedTv20sBehavior && error.code === 'intermediate-p2-p3-impedance');

  const neighbour = new Tv20sEnvironment({ referenceNetlist: importNetlist('wf26') });
  neighbour.apply('neighbour-ring', 0);
  assert.throws(() => neighbour.apply('neighbour-door', 100), (error) =>
    error instanceof UnsupportedTv20sBehavior && error.code === 'neighbour-door-during-gong');
});

test('TV20/S environment exposes measured virtual-time boundaries instead of settlement deadlines', () => {
  const environment = new Tv20sEnvironment({ referenceNetlist: importNetlist('wf26') });
  environment.apply('own-ring', 100);
  assert.equal(environment.nextEventAt(100, 100000), 1100);
  assert.equal(environment.nextEventAt(1100, 100000), 4000);
  assert.equal(environment.nextEventAt(4000, 100000), 60100);
  assert.equal(environment.hasDynamics(500), true);
  assert.equal(environment.hasDynamics(5000), false);
});
