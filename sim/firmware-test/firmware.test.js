import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';

import { FirmwareCircuitRunner, HeadCircuitFixture } from './circuit-runner.js';
import { OWN_RING_ONSET } from '../test-support/fixtures/captured-waveforms.js';
import { createSimulatorServer, stopAllSessions } from '../server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const HOST_YAML = join(REPO, 'firmware', 'doorbell-host.yaml');
const HOST_BINARY = join(REPO, 'firmware', '.esphome', 'build', 'doorbell-host', '.pioenvs', 'doorbell-host', 'program');
let productionResolved = '';
let benchResolved = '';

function exec(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd: REPO, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

before(async () => {
  if (process.env.DOORBELL_SKIP_CONFIG !== '1') {
    const [production, bench] = await Promise.all([
      exec('esphome', ['config', join(REPO, 'firmware', 'doorbell.yaml')]),
      exec('esphome', ['config', join(REPO, 'firmware', 'doorbell-bench.yaml')]),
    ]);
    productionResolved = production.stdout;
    benchResolved = bench.stdout;
  }
  if (process.env.DOORBELL_SKIP_HOST_BUILD !== '1')
    await exec('esphome', ['compile', HOST_YAML]);
  await stat(HOST_BINARY);
});

function absoluteEvents(startMs, events) {
  return events.map((event) => ({ ...event, at: startMs + event.at }));
}

async function runScenario(name, {
  startMs = 0,
  events = [],
  endAt = 1000,
  slowdownMs = 0,
  responseVersion,
  expectedExit = 0,
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'doorbell-fw-'));
  const socketPath = join(temporary, 'runner.sock');
  const allEvents = absoluteEvents(startMs, [
    ...events,
    { at: endAt, type: 'command', command: expectedExit === 90 ? 'CRASH' : 'EXIT' },
  ]);
  const runner = new FirmwareCircuitRunner({ socketPath, startMs, events: allEvents, slowdownMs,
    responseVersion });
  let stdout = '';
  let stderr = '';
  try {
    await runner.listen();
    const child = spawn(HOST_BINARY, [], {
      cwd: REPO,
      env: {
        ...process.env,
        DOORBELL_FIRMWARE_TEST_SOCKET: socketPath,
        DOORBELL_FIRMWARE_TEST_START_MS: String(startMs),
        ESPHOME_PREFDIR: join(temporary, 'preferences'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const result = await Promise.race([
      new Promise((resolveChild) => child.once('exit', (code, signal) => resolveChild({ code, signal }))),
      new Promise((_, reject) => {
        // This is only a deadlock guard. Virtual time—not wall time—governs every assertion, while
        // slower hosts may spend longer solving the live circuit during ten-second WAV scenarios.
        const timer = setTimeout(() => reject(new Error(`${name}: host process timed out`)), 60000);
        timer.unref();
      }),
      new Promise((_, reject) => runner.once('failure', reject)),
    ]);
    if (result.code === 90) runner.fixture.crash();
    assert.equal(result.signal, null, `${name}: host terminated by ${result.signal}`);
    assert.equal(result.code, expectedExit,
      `${name}: exit ${result.code}\nstdout:\n${stdout}\nstderr:\n${stderr}\ntimeline:\n${runner.compactTimeline()}`);
    if (runner.failure) throw runner.failure;
    return { timeline: runner.timeline, fixture: runner.fixture, stdout, stderr };
  } catch (error) {
    error.message += `\n${name} timeline:\n${runner.compactTimeline()}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    throw error;
  } finally {
    await runner.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

const writes = (timeline, signal, value) => timeline.filter((item) =>
  item.type === 'write' && item.signal === signal && (value === undefined || item.value === value));
const entities = (timeline, name, value = true) => timeline.filter((item) =>
  item.type === 'entity' && item.name === name && item.value === value);
const media = (timeline, state) => timeline.filter((item) => item.type === 'media' && item.state === state);

function assertNoUnsafeDoorWrites(timeline) {
  assert.equal(writes(timeline, 'DOOR_DRV', true).length, 0,
    'scenario must not assert the opener');
}

async function waitForSse(url, predicate, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before expected event');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        const message = JSON.parse(line.slice(6));
        if (predicate(message)) return message;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test('HEAD handshake validates the live U1 and P1-P5 mappings', () => {
  const fixture = new HeadCircuitFixture();
  assert.deepEqual(fixture.readInputs(), { mask: 15, adcMv: 425 });
  assert.throws(() => fixture.validateHello(['PTT_DRV=8']), /mapping mismatch/);
});

test('production keeps the installed V4.1 profile while bench retains documented diagnostics', {
  skip: process.env.DOORBELL_SKIP_CONFIG === '1' ? 'already resolved by ./build.sh firmware-test' : false,
}, () => {
  assert.match(productionResolved, /name: doorbell\n/);
  assert.match(productionResolved, /i2s_dout_pin: 1\n/);
  assert.doesNotMatch(productionResolved, /p4_isolation_req|K5_SENSE_N|PTT_SENSE_N/);
  assert.match(benchResolved, /name: doorbell2\n/);
  assert.match(benchResolved, /id: p4_isolation_req\n/);
  assert.match(benchResolved, /id: debug_k5_sense\n/);
});

test('a stable ESP32-indeterminate input fails with the affected net and voltage', () => {
  const fixture = new HeadCircuitFixture();
  const voltage = fixture.voltage.bind(fixture);
  fixture.voltage = (net) => net === '/P4_SENSE_N' ? 1.65 : voltage(net);
  fixture.nowMs = 100;
  fixture.readInputs(); // first sample is allowed as Schmitt-transition hysteresis
  fixture.nowMs = 120;
  assert.throws(() => fixture.readInputs(), /P4_SENSE_N.*indeterminate region at 1\.650 V/);
});

test('safe boot leaves every actuator inactive and reports no false ring', async () => {
  const { timeline } = await runScenario('safe boot', { endAt: 250 });
  assertNoUnsafeDoorWrites(timeline);
  assert.equal(writes(timeline, 'PTT_DRV', true).length, 0);
  assert.equal(writes(timeline, 'P4_ISO', true).length, 0);
  assert.equal(writes(timeline, 'MUTE_DRV', true).length, 0);
  assert.equal(entities(timeline, 'house_ring').length, 0);
  assert.equal(entities(timeline, 'apartment_ring').length, 0);
});

test('valid front-door ring is detected once and auto-open disabled never opens', async () => {
  const { timeline, stdout } = await runScenario('front ring, no auto-open', {
    events: [
      {
        at: 100,
        type: 'captured',
        line: 'P4',
        // Preserve the measured onset while using a 0.5 ms bounded fixture sample here; the
        // circuit-only replay retains the repository's full 0.1 ms decimation.
        dtMs: OWN_RING_ONSET.dt * 5000,
        values: OWN_RING_ONSET.p4.filter((_, index) => index % 5 === 0),
      },
      { at: 250, type: 'source', line: 'P4', value: null },
    ],
    endAt: 400,
  });
  assert.equal(entities(timeline, 'house_ring').length, 1,
    `${JSON.stringify(timeline, null, 2)}\nfirmware log:\n${stdout}`);
  assertNoUnsafeDoorWrites(timeline);
});

test('front-door debounce rejects a sub-50 ms P4 pulse', async () => {
  const { timeline } = await runScenario('short front ring', {
    events: [
      // Six volts crosses OC1 but cannot pull in K5, so this remains a true short sense pulse.
      { at: 100, type: 'pulse', line: 'P4', low: 0, high: 6, periodMs: 1000, widthMs: 20, count: 1 },
      { at: 130, type: 'source', line: 'P4', value: null },
    ],
    endAt: 400,
  });
  assert.equal(entities(timeline, 'house_ring').length, 0);
  assertNoUnsafeDoorWrites(timeline);
});

test('audio-rate P5 pulses stretch into one apartment ring', async () => {
  const { timeline } = await runScenario('apartment ring tone', {
    events: [
      // 681 Hz and the loaded peak reproduce the captured floor-call connector waveform through
      // the fixture's required 90 ohm Thevenin source.
      { at: 100, type: 'tone', line: 'P5', offset: 0, amplitude: 36, frequency: 681 },
      { at: 350, type: 'source', line: 'P5', value: null },
    ],
    endAt: 650,
  });
  assert.equal(entities(timeline, 'apartment_ring').length, 1,
    JSON.stringify(timeline.filter((item) => item.type === 'entity' || item.type === 'at'), null, 2));
  assert.equal(entities(timeline, 'house_ring').length, 0);
  assertNoUnsafeDoorWrites(timeline);
});

test('a simultaneous house gong masks the apartment optocoupler tone', async () => {
  const { timeline } = await runScenario('simultaneous rings', {
    events: [
      { at: 100, type: 'source', line: 'P4', value: 12 },
      { at: 100, type: 'tone', line: 'P5', offset: 0, amplitude: 36, frequency: 681 },
      { at: 350, type: 'source', line: 'P5', value: null },
    ],
    endAt: 550,
  });
  assert.equal(entities(timeline, 'house_ring').length, 1);
  assert.equal(entities(timeline, 'apartment_ring').length, 0);
  assertNoUnsafeDoorWrites(timeline);
});

test('chime truth table is fail-safe across HA state, suppression and force override', async () => {
  const { timeline } = await runScenario('chime truth table', {
    events: [
      { at: 100, type: 'command', command: 'SET:ha:1' },
      { at: 150, type: 'command', command: 'SET:suppress_chime:1' },
      { at: 250, type: 'command', command: 'SET:force_chime:1' },
      { at: 350, type: 'command', command: 'SET:force_chime:0' },
      { at: 450, type: 'command', command: 'SET:ha:0' },
    ],
    endAt: 650,
  });
  const muteHigh = writes(timeline, 'MUTE_DRV', true);
  const muteLow = writes(timeline, 'MUTE_DRV', false);
  assert.ok(muteHigh.some((item) => item.at >= 150 && item.at < 250), 'suppression should open K3');
  assert.ok(muteLow.some((item) => item.at >= 250 && item.at < 350), 'force override should close K3');
  assert.ok(muteHigh.some((item) => item.at >= 350 && item.at < 450), 'clearing force should restore suppression');
  assert.ok(muteLow.some((item) => item.at >= 450), 'HA disconnect must fail safe to an audible gong');
  assertNoUnsafeDoorWrites(timeline);
});

for (const [selection, expectedName] of [
  ['None', null],
  ['Chime', 'welcome_chime'],
  ['Silent', 'welcome_silent'],
  ['Hello', 'welcome_hello'],
  ['Secret', 'welcome_secret'],
  ['Windows', 'welcome_windows'],
]) {
  test(`greeting selection ${selection} reaches the fake player with real WAV duration`, async () => {
    const { timeline } = await runScenario(`greeting ${selection}`, {
      events: [
        { at: 100, type: 'command', command: `SELECT:${selection}` },
        { at: 150, type: 'command', command: 'PRESS:play' },
      ],
      endAt: selection === 'Silent' ? 11000 : selection === 'Windows' ? 7200 : 3000,
    });
    const starts = media(timeline, 'START');
    if (expectedName === null) {
      assert.equal(starts.length, 0);
      assert.equal(writes(timeline, 'PTT_DRV', true).length, 0);
    } else {
      assert.equal(starts.length, 1);
      assert.equal(starts[0].name, expectedName);
      assert.ok(starts[0].duration > 0);
      const pttOn = writes(timeline, 'PTT_DRV', true)[0];
      const pttOff = writes(timeline, 'PTT_DRV', false).at(-1);
      assert.ok(pttOn.at <= starts[0].at, 'K1 must precede media');
      assert.ok(pttOff.at >= starts[0].at + starts[0].duration, 'K1 must cover actual WAV duration');
      assert.equal(entities(timeline, 'apartment_ring').length, 0,
        'PTT/session audio must not become an apartment ring');
    }
    assertNoUnsafeDoorWrites(timeline);
  });
}

test('ring greeting uses K5-confirmed P4 isolation before K1 and opens only after TX', async () => {
  const { timeline } = await runScenario('ring greet and open', {
    events: [
      { at: 20, type: 'command', command: 'SET:auto_open:1' },
      { at: 30, type: 'command', command: 'SELECT:Secret' },
      { at: 100, type: 'source', line: 'P4', value: 12 },
      { at: 1100, type: 'source', line: 'P4', value: null },
    ],
    endAt: 5500,
  });
  const isolate = writes(timeline, 'P4_ISO', true)[0];
  const ptt = writes(timeline, 'PTT_DRV', true)[0];
  const start = media(timeline, 'START')[0];
  const stop = media(timeline, 'IDLE').find((item) => item.duration > 0);
  const pttOff = writes(timeline, 'PTT_DRV', false).find((item) => item.at >= stop.at);
  const door = writes(timeline, 'DOOR_DRV', true)[0];
  assert.ok(isolate && ptt && start && stop && door, 'expected isolation, TX, media and door transitions');
  assert.ok(isolate.at < ptt.at, 'K6 request must precede K1');
  assert.ok(ptt.at >= 1550, 'ring-triggered TX must retain the conservative 1.45 s guard');
  assert.ok(door.at >= stop.at + 100 && door.at >= pttOff.at + 100,
    'door must follow media completion and the K1 release margin');
  assert.ok(door.at >= 1850, 'door must respect the 1.75 s ring minimum');
  const k4Open = timeline.find((item) => item.type === 'electrical' && item.name === 'K4' && item.value === true);
  const k2Made = timeline.find((item) => item.type === 'electrical' && item.name === 'K2' && item.value === true);
  assert.ok(k4Open && k2Made, `missing physical K4/K2 transition:\n${JSON.stringify(timeline, null, 2)}`);
  assert.ok(k4Open.at < k2Made.at, 'K4 break must electrically lead K2 make');
});

test('ring-triggered auto-open with no greeting never asserts K1', async () => {
  const { timeline } = await runScenario('ring open without greeting', {
    events: [
      { at: 20, type: 'command', command: 'SET:auto_open:1' },
      { at: 100, type: 'source', line: 'P4', value: 12 },
      { at: 1100, type: 'source', line: 'P4', value: null },
    ],
    endAt: 4200,
  });
  assert.equal(media(timeline, 'START').length, 0);
  assert.equal(writes(timeline, 'PTT_DRV', true).length, 0);
  const door = writes(timeline, 'DOOR_DRV', true);
  assert.equal(door.length, 1);
  assert.ok(door[0].at >= 1850);
});

test('physical Talk takes ownership: media, K1, K6 and K3 return passive', async () => {
  const { timeline } = await runScenario('physical PTT handoff', {
    events: [
      { at: 100, type: 'command', command: 'SELECT:Windows' },
      { at: 150, type: 'command', command: 'PRESS:play' },
      { at: 700, type: 'switch', ref: 'SW4', closed: true },
      { at: 1100, type: 'switch', ref: 'SW4', closed: false },
    ],
    endAt: 1500,
  });
  assert.equal(entities(timeline, 'physical_ptt').length, 1);
  const takeover = entities(timeline, 'physical_ptt')[0].at;
  assert.ok(writes(timeline, 'PTT_DRV', false).some((item) => item.at >= takeover));
  assert.ok(writes(timeline, 'P4_ISO', false).some((item) => item.at >= takeover));
  assert.ok(writes(timeline, 'MUTE_DRV', false).some((item) => item.at >= takeover));
  assert.ok(media(timeline, 'IDLE').some((item) => item.at >= takeover));
  assertNoUnsafeDoorWrites(timeline);
});

test('K5 loss aborts an isolated smart transmission and restores K1/K6', async () => {
  const { timeline } = await runScenario('K5 loss during TX', {
    events: [
      { at: 100, type: 'source', line: 'P4', value: 12 },
      { at: 200, type: 'command', command: 'SELECT:Windows' },
      { at: 250, type: 'command', command: 'PRESS:play' },
      { at: 1100, type: 'source', line: 'P4', value: null },
      { at: 2200, type: 'source', line: 'P2', value: 0 },
    ],
    endAt: 3000,
  });
  const start = media(timeline, 'START')[0];
  const idle = media(timeline, 'IDLE').find((item) => item.at > start.at);
  const release = entities(timeline, 'k5_sense', false).at(-1);
  assert.ok(start && idle && release);
  assert.ok(idle.at < start.at + start.duration, 'K5 loss must abort before WAV completion');
  assert.ok(writes(timeline, 'PTT_DRV', false).some((item) => item.at >= release.at));
  assert.ok(writes(timeline, 'P4_ISO', false).some((item) => item.at >= release.at));
  assertNoUnsafeDoorWrites(timeline);
});

test('HA disconnect during playback remains muted until media ownership ends', async () => {
  const { timeline } = await runScenario('HA loss during playback', {
    events: [
      { at: 50, type: 'command', command: 'SET:ha:1' },
      { at: 60, type: 'command', command: 'SET:suppress_chime:1' },
      { at: 100, type: 'command', command: 'SELECT:Hello' },
      { at: 150, type: 'command', command: 'PRESS:play' },
      { at: 500, type: 'command', command: 'SET:ha:0' },
    ],
    endAt: 1800,
  });
  const start = media(timeline, 'START')[0];
  const idle = media(timeline, 'IDLE').find((item) => item.at >= start.at + start.duration);
  assert.ok(writes(timeline, 'MUTE_DRV', true).some((item) => item.at <= start.at));
  assert.equal(writes(timeline, 'MUTE_DRV', false)
    .filter((item) => item.at >= 500 && item.at < idle.at).length, 0);
  assert.ok(writes(timeline, 'MUTE_DRV', false).some((item) => item.at >= idle.at));
  assertNoUnsafeDoorWrites(timeline);
});

test('door coordinator tears down TX and rejects a rapid repeat during pulse/re-arm', async () => {
  const { timeline } = await runScenario('door coordinator', {
    events: [
      { at: 100, type: 'command', command: 'SELECT:Windows' },
      { at: 150, type: 'command', command: 'PRESS:play' },
      { at: 500, type: 'command', command: 'PRESS:door' },
      { at: 700, type: 'command', command: 'PRESS:door' },
      { at: 2900, type: 'command', command: 'PRESS:door' },
    ],
    endAt: 5200,
  });
  const doorOn = writes(timeline, 'DOOR_DRV', true);
  assert.equal(doorOn.length, 2, 'one rapid request must be coalesced/rejected, later request accepted');
  const pttOff = writes(timeline, 'PTT_DRV', false).find((item) => item.at >= 500);
  assert.ok(pttOff.at < doorOn[0].at, 'K1 must release before DOOR_DRV rises');
  assert.ok(doorOn[1].at - doorOn[0].at >= 2250, 'door pulses need 1.75 s high plus 500 ms low');
});

test('32-bit millis rollover does not delay a manual greeting or ring/open deadlines', async () => {
  const startMs = 0xFFFF_FF00;
  const { timeline } = await runScenario('rollover', {
    startMs,
    events: [
      { at: 20, type: 'command', command: 'SELECT:Secret' },
      { at: 30, type: 'command', command: 'PRESS:play' },
    ],
    endAt: 2200,
  });
  const ptt = writes(timeline, 'PTT_DRV', true)[0];
  assert.ok(ptt.at - startMs < 100, `manual greeting was delayed across rollover: ${ptt.at - startMs} ms`);
});

test('ring-to-open minimum remains correct across 32-bit millis rollover', async () => {
  const startMs = 0xFFFF_FF00;
  const { timeline } = await runScenario('ring/open rollover', {
    startMs,
    events: [
      { at: 20, type: 'command', command: 'SET:auto_open:1' },
      { at: 40, type: 'source', line: 'P4', value: 12 },
      { at: 1040, type: 'source', line: 'P4', value: null },
    ],
    endAt: 4000,
  });
  const ring = entities(timeline, 'house_ring')[0];
  const door = writes(timeline, 'DOOR_DRV', true)[0];
  assert.ok(door.at - ring.at >= 1750, `ring/open delay was ${door.at - ring.at} ms`);
  assert.equal(writes(timeline, 'PTT_DRV', true).length, 0);
});

test('never-ending media reaches the 30 s timeout and releases K1/K3/K6', async () => {
  const { timeline } = await runScenario('media timeout', {
    events: [
      { at: 50, type: 'command', command: 'MEDIA_FAULT:never' },
      { at: 100, type: 'command', command: 'SELECT:Chime' },
      { at: 150, type: 'command', command: 'PRESS:play' },
    ],
    endAt: 31000,
  });
  const start = media(timeline, 'START')[0];
  const pttOff = writes(timeline, 'PTT_DRV', false).at(-1);
  assert.ok(pttOff.at >= start.at + 30000, 'K1 must remain owned until the timeout');
  assert.equal(writes(timeline, 'P4_ISO', false).at(-1).at, pttOff.at);
  assertNoUnsafeDoorWrites(timeline);
});

test('host/circuit trace is independent of artificial wall-clock slowdown', async () => {
  const scenario = {
    events: [
      { at: 100, type: 'command', command: 'SET:ha:1' },
      { at: 120, type: 'command', command: 'SET:suppress_chime:1' },
      { at: 200, type: 'command', command: 'SELECT:Secret' },
      { at: 250, type: 'command', command: 'PRESS:play' },
    ],
    endAt: 2200,
  };
  const normal = await runScenario('normal wall speed', scenario);
  const slow = await runScenario('slow wall speed', { ...scenario, slowdownMs: 2 });
  const policyTrace = (timeline) => timeline.filter((item) => ['write', 'media', 'entity'].includes(item.type));
  assert.deepEqual(policyTrace(slow.timeline), policyTrace(normal.timeline));
});

test('crash removes U1 drivers and physical pull-downs restore passive actuator state', async () => {
  const { timeline, fixture } = await runScenario('crash recovery', {
    events: [
      { at: 100, type: 'command', command: 'SELECT:Windows' },
      { at: 150, type: 'command', command: 'PRESS:play' },
    ],
    endAt: 500,
    expectedExit: 90,
  });
  assert.ok(writes(timeline, 'PTT_DRV', true).length > 0, 'precondition: firmware asserted K1');
  const physical = fixture.stepper.extractState();
  assert.equal(physical.ssrs.K1, false);
  assert.equal(physical.ssrs.K2, false);
  assert.equal(physical.ssrs.K3, false);
  assert.equal(physical.ssrs.K6, false);
});

test('crash during a door pulse removes DOOR_DRV and restores K2/K4 passive state', async () => {
  const { timeline, fixture } = await runScenario('crash during door pulse', {
    events: [{ at: 100, type: 'command', command: 'PRESS:door' }],
    endAt: 500,
    expectedExit: 90,
  });
  assert.equal(writes(timeline, 'DOOR_DRV', true).length, 1);
  const physical = fixture.stepper.extractState();
  assert.equal(physical.ssrs.K2, false);
  assert.equal(physical.ssrs.K4, false);
});

test('protocol version mismatches fail clearly before simulation starts', () => {
  const runner = new FirmwareCircuitRunner({ socketPath: '/unused' });
  assert.throws(() => runner.parseVersion(['HELLO', '999']), /protocol version mismatch.*999/);
});

test('host rejects an incompatible runner protocol before boot', async () => {
  const { stdout, stderr } = await runScenario('incompatible runner protocol', {
    responseVersion: 999,
    endAt: 50,
    expectedExit: 73,
  });
  assert.match(stdout + stderr, /protocol mismatch: AT 999/);
});

test('circuit solver failures propagate without an AT response', () => {
  const fixture = new HeadCircuitFixture();
  fixture.applyEvent({ at: fixture.nowMs, type: 'source', line: 'P4', value: 12 });
  const rebuild = fixture.rebuild.bind(fixture);
  const failStep = () => { throw new Error('nonlinear solve did not converge: synthetic non-convergence'); };
  fixture.rebuild = (...args) => { rebuild(...args); fixture.stepper.step = failStep; };
  fixture.stepper.step = failStep;
  assert.throws(() => fixture.advanceTo(1), /synthetic non-convergence/);
});

test('interactive 50 V VBUS edit refines the clamp transition and blows F1', () => {
  const fixture = new HeadCircuitFixture();
  fixture.configureCircuit({
    sources: [
      { net: '/VBUS', type: 'dc', v1: 50, v2: 0, freq: 1000, t1: 1, impedance: 0, off: false },
      { net: '/P2', type: 'dc', v1: 12, v2: 0, freq: 1000, t1: 1, impedance: 90, off: false },
    ],
    elements: [],
    switches: { JP1: true, JP3: true },
  });
  while (fixture.nowMs < 200) fixture.advanceTo(200);
  const state = fixture.snapshot();
  assert.equal(state.fuses.F1.blown, true, 'the strict physical fuse model must clear the downstream rail');
  assert.ok(state.voltages['+5V'] < 1, `+5V should collapse after F1 opens, got ${state.voltages['+5V']} V`);
});

test('interactive server has one firmware-backed HEAD mode with virtual pause/step', async () => {
  const server = createSimulatorServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let id;
  try {
    const createdResponse = await fetch(`${origin}/api/sessions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board: 'doorbell' }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    id = created.id;
    assert.equal(created.capabilities.firmware, true);
    assert.equal(created.config.sources.find((item) => item.net === '/P2').impedance, 90);

    const stepResponse = await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'step' }) });
    assert.equal(stepResponse.status, 202);
    const stepped = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'sample' && message.sample.at >= 1 && message.firmware.connected);
    assert.equal(stepped.sample.at, 1);

    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'crash' }) });
    const crashed = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'sample' && message.firmware.crashed);
    assert.equal(crashed.sample.at, 1, 'crash must preserve virtual circuit time');
    assert.ok(Object.values(crashed.firmware.outputs).every((value) => value === false));

    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'reboot' }) });
    const rebooted = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'sample' && message.firmware.connected && !message.firmware.crashed);
    assert.equal(rebooted.sample.at, 1, 'reboot must preserve physical circuit time');

    const overvoltageConfig = { ...created.config, sources: created.config.sources.map((item) =>
      item.net === '/VBUS' ? { ...item, v1: 50 } : item) };
    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'configure', config: overvoltageConfig }) });
    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'step' }) });
    const fused = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'sample' && message.sample.fuses.F1.blown);
    assert.equal(fused.sample.fuses.F1.blown, true);

    const unsafeConfig = { ...created.config, sources: [...created.config.sources, {
      net: '/PTT_DRV', type: 'dc', v1: 3.3, v2: 0, freq: 1000, t1: 0,
      impedance: 0, off: false,
    }] };
    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'configure', config: unsafeConfig }) });
    const rejected = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'error' && /firmware-owned/.test(message.message));
    assert.match(rejected.message, /PTT_DRV.*firmware-owned/);

    await fetch(`${origin}/api/sessions/${id}`, { method: 'DELETE' });
    id = null;
    const wfResponse = await fetch(`${origin}/api/sessions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board: 'wf26' }) });
    assert.equal(wfResponse.status, 201);
    const wf = await wfResponse.json();
    id = wf.id;
    assert.equal(wf.capabilities.firmware, false, 'the reference handset must remain passive');
    await fetch(`${origin}/api/sessions/${id}/actions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'step' }) });
    const wfStepped = await waitForSse(`${origin}/api/sessions/${id}/events`, (message) =>
      message.type === 'sample' && message.sample.at >= 1);
    assert.equal(wfStepped.board, 'wf26');
  } finally {
    if (id) await fetch(`${origin}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    await stopAllSessions();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test.todo('production K5-confirmed P4 isolation awaits fabricated V4.2 validation (TODO.md)');
test.todo('production GPIO47 physical-Talk handoff awaits fabricated V4.2 validation (TODO.md)');
test.todo('production universal door-command coordination/re-arm remains gated in TODO.md');
test.todo('longer-lived passive-listening/K3 policy remains a post-fabrication decision (TODO.md)');
