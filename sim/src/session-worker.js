import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { FirmwareCircuitRunner } from '../firmware-test/circuit-runner.js';
import { allComponents, buildElements, defaultSwitchState } from './components/index.js';
import { createStepper, gndOf, makeWave, parseVal } from './engine.js';

const { board, netlist, binary, repoRoot } = workerData;
const components = allComponents(netlist);
const knownNets = new Set(netlist.nets);
const firmwareNets = new Set();
if (board === 'doorbell') firmwareNets.add('/P4_ISO');
for (const component of components) {
  const schema = component.programSchema?.();
  if (schema?.kind === 'esp') for (const gpio of schema.gpios) firmwareNets.add(gpio.net);
  if (schema?.kind === 'codec') {
    const raw = netlist.components.find((item) => item.ref === component.ref);
    for (const pin in raw?.pinfn || {})
      if (/OUTP|OUTN/.test(raw.pinfn[pin])) firmwareNets.add(raw.pins[pin]);
  }
}

let speed = 0;
let lastWall = Date.now();
let fractionalMs = 0;
let latestSample = null;
let lastSampleWall = 0;
let sampleGeneration = 0;
let lastSentGeneration = -1;
let timelineIndex = 0;
let temporary = null;
let socketPath = null;
let runner = null;
let passive = null;
let child = null;
let intentionalExit = false;
let shuttingDown = false;
let config = initialConfig();
const firmware = {
  connected: false,
  crashed: false,
  outputs: { PTT_DRV: false, DOOR_DRV: false, MUTE_DRV: false, P4_ISO: false },
  entities: {},
  media: { active: false, name: null, duration: 0 },
};

const activeFaults = new Map();
let faultId = 0;

function post(type, payload = {}) {
  parentPort.postMessage({ type, ...payload });
}

function initialConfig() {
  const sources = (netlist.config?.sources || []).map((item) => ({
    net: item.net,
    type: item.type || 'dc',
    v1: item.v1 ?? 0,
    v2: item.v2 ?? 0,
    freq: item.freq ?? 1000,
    t1: item.t1 ?? 1,
    impedance: ['/P2', '/P4', '/P5'].includes(item.net) ? 90 : 0,
    off: false,
  }));
  return { sources, elements: [], switches: defaultSwitchState(netlist), gnd: gndOf(netlist), dtUs: 200 };
}

function rawElements(items) {
  return items.map((item, index) => {
    const base = { a: item.a, b: item.b, ref: `INTERACTIVE_${index}` };
    if (item.kind === 'short') return { ...base, type: 'R', value: 1e-3 };
    if (item.kind === 'switch') return { ...base, type: 'SW', closed: Boolean(item.closed) };
    if (item.kind === 'D') return { ...base, type: 'D', Is: 1e-12, n: 1.8 };
    const value = parseVal(item.value);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`extra element ${index + 1} requires a positive value`);
    return { ...base, type: item.kind, value };
  });
}

function validateConfig(next) {
  if (!next || !Array.isArray(next.sources) || !Array.isArray(next.elements))
    throw new Error('circuit configuration must contain source and element arrays');
  const ideal = new Set();
  const sources = next.sources.map((item, index) => {
    if (!knownNets.has(item.net)) throw new Error(`source ${index + 1} uses unknown net ${item.net}`);
    if (!['dc', 'sine', 'square', 'step', 'pulse'].includes(item.type))
      throw new Error(`source ${index + 1} has unknown waveform ${item.type}`);
    const normalized = { ...item };
    for (const key of ['v1', 'v2', 'freq', 't1', 'impedance']) {
      normalized[key] = Number(item[key]);
      if (!Number.isFinite(normalized[key])) throw new Error(`source ${index + 1} ${key} must be finite`);
    }
    if (normalized.impedance < 0) throw new Error(`source ${index + 1} impedance cannot be negative`);
    if (!normalized.off && normalized.impedance === 0) {
      if (ideal.has(normalized.net)) throw new Error(`multiple ideal sources drive ${normalized.net}`);
      if (board === 'doorbell' && firmwareNets.has(normalized.net))
        throw new Error(`${normalized.net} is firmware-owned; use non-zero source impedance`);
      ideal.add(normalized.net);
    }
    return normalized;
  });
  const elements = next.elements.map((item, index) => {
    if (!['R', 'C', 'L', 'D', 'short', 'switch'].includes(item.kind))
      throw new Error(`extra element ${index + 1} has unknown kind ${item.kind}`);
    if (!knownNets.has(item.a) || !knownNets.has(item.b))
      throw new Error(`extra element ${index + 1} uses an unknown net`);
    return { ...item };
  });
  const dtUs = Number(next.dtUs ?? config.dtUs);
  if (!Number.isFinite(dtUs) || dtUs < 1 || dtUs > 100000)
    throw new Error('dt must be between 1 and 100000 µs');
  if (board === 'doorbell' && next.gnd !== gndOf(netlist))
    throw new Error(`doorbell firmware sessions require ${gndOf(netlist)} as circuit ground`);
  const gnd = knownNets.has(next.gnd) ? next.gnd : config.gnd;
  return { sources, elements, switches: { ...next.switches }, dtUs, gnd };
}

function trackSafety(sample) {
  const vn = {};
  for (const [net, value] of Object.entries(sample.voltages))
    vn[net] = sample.floating?.[net] ? Number.NaN : value;
  const seen = new Set();
  for (const component of components) {
    const fuse = component.kind === 'fuse';
    for (const issue of component.checkSafe(vn)) {
      const key = `${issue.ref}.${issue.pin}`;
      seen.add(key);
      const excess = Math.max(issue.lo - issue.v, issue.v - issue.hi);
      let fault = activeFaults.get(key);
      if (!fault) {
        fault = { id: ++faultId, ref: issue.ref, pin: issue.pin, net: issue.net,
          kind: fuse ? 'fuse' : 'absmax', lo: issue.lo, hi: issue.hi, why: issue.why,
          t0: sample.at / 1000, peak: issue.v, peakT: sample.at / 1000, peakExc: excess, end: null };
        activeFaults.set(key, fault);
        post('fault', { fault: { ...fault } });
      } else if (excess > fault.peakExc) {
        fault.peakExc = excess;
        fault.peak = issue.v;
        fault.peakT = sample.at / 1000;
        post('fault', { fault: { ...fault } });
      }
    }
  }
  for (const [key, fault] of activeFaults) {
    if (seen.has(key)) continue;
    fault.end = sample.at / 1000;
    activeFaults.delete(key);
    post('fault', { fault: { ...fault } });
  }
}

function receiveSample(sample) {
  latestSample = sample;
  sampleGeneration++;
  trackSafety(sample);
}

function emitSample(force = false) {
  if (!latestSample) return;
  const now = Date.now();
  if (!force && (sampleGeneration === lastSentGeneration || now - lastSampleWall < 30)) return;
  lastSampleWall = now;
  lastSentGeneration = sampleGeneration;
  post('sample', { sample: latestSample, firmware, speed, board });
}

function emitTimeline() {
  if (!runner) return;
  while (timelineIndex < runner.timeline.length) {
    const item = runner.timeline[timelineIndex++];
    if (item.type === 'write') firmware.outputs[item.signal] = item.value;
    else if (item.type === 'entity') firmware.entities[item.name] = item.value;
    else if (item.type === 'media') firmware.media = {
      active: item.state === 'START', name: item.name === '-' ? null : item.name, duration: item.duration,
    };
    post('timeline', { item });
  }
  post('firmware', { firmware });
  emitSample();
}

class PassiveCircuit {
  constructor() {
    this.nowMs = 0;
    this.seconds = 0;
    this.rebuild(null);
    this.stepper.step(0);
    this.capture();
  }

  rebuild(seed = this.stepper?.extractState()) {
    const extra = rawElements(config.elements);
    const sources = [];
    for (let index = 0; index < config.sources.length; index++) {
      const item = config.sources[index];
      if (item.off) continue;
      const wave = makeWave(item);
      if (item.impedance > 0) {
        const sourceNet = `/INTERACTIVE_SOURCE_${index}`;
        extra.push({ type: 'R', a: sourceNet, b: item.net, value: item.impedance,
          ref: `INTERACTIVE_SOURCE_R${index}` });
        sources.push({ net: sourceNet, vf: () => wave(this.seconds) });
      } else sources.push({ net: item.net, vf: () => wave(this.seconds) });
    }
    const elements = buildElements(netlist, { switchState: config.switches, extra });
    this.stepper = createStepper(elements, sources, config.gnd, config.dtUs / 1e6, seed);
  }

  configure() {
    this.rebuild();
    this.stepper.step(this.seconds);
    this.capture();
  }

  advance(milliseconds) {
    const dtMs = config.dtUs / 1000;
    const target = this.nowMs + milliseconds;
    while (this.nowMs + 1e-9 < target) {
      const stepMs = Math.min(dtMs, target - this.nowMs);
      if (Math.abs(stepMs - dtMs) > 1e-9) {
        const seed = this.stepper.extractState();
        const originalDt = config.dtUs;
        config.dtUs = stepMs * 1000;
        this.rebuild(seed);
        config.dtUs = originalDt;
      }
      this.nowMs += stepMs;
      this.seconds = this.nowMs / 1000;
      this.stepper.step(this.seconds);
      this.capture();
      if (Math.abs(stepMs - dtMs) > 1e-9) this.rebuild(this.stepper.extractState());
    }
  }

  capture() {
    const voltages = { [this.stepper.gnd]: 0 };
    for (const net of this.stepper.nodes) voltages[net] = this.stepper.vn[this.stepper.ni[net]];
    const state = this.stepper.extractState();
    receiveSample({ at: this.nowMs, voltages, floating: this.stepper.floatingMap(),
      relays: state.relays, ssrs: state.ssrs, fuses: state.fuses,
      injections: this.stepper.padInjections() });
  }
}

async function spawnHost() {
  if (child) return;
  intentionalExit = false;
  firmware.crashed = false;
  child = spawn(binary, [], {
    cwd: repoRoot,
    env: { ...process.env, DOORBELL_FIRMWARE_TEST_SOCKET: socketPath,
      DOORBELL_FIRMWARE_TEST_START_MS: String(Math.trunc(runner.fixture.nowMs)),
      ESPHOME_PREFDIR: join(temporary, 'preferences') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, level] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.setEncoding('utf8');
    stream.on('data', (text) => post('log', { level, text }));
  }
  const current = child;
  current.once('exit', (code, signal) => {
    if (child === current) child = null;
    firmware.connected = false;
    if (!intentionalExit && !shuttingDown) {
      firmware.crashed = true;
      runner.fixture.crash(0);
      receiveSample(runner.fixture.snapshot());
      post('status', { status: 'crashed', detail: `firmware exited (${signal || code})` });
      emitSample(true);
    }
  });
}

async function initDoorbell() {
  // macOS limits sockaddr_un paths to 104 bytes; tmpdir() is already long, so keep both suffixes short.
  temporary = await mkdtemp(join(tmpdir(), 'dbs-'));
  socketPath = join(temporary, 's');
  runner = new FirmwareCircuitRunner({ socketPath, interactive: true,
    fixtureOptions: { netlist, onSample: receiveSample } });
  runner.on('failure', (error) => post('error', { message: error.message, stack: error.stack }));
  runner.on('update', () => {
    receiveSample(runner.fixture.snapshot());
    emitTimeline();
  });
  runner.on('disconnect', () => { firmware.connected = false; emitSample(true); });
  await runner.listen();
  runner.server.on('connection', () => { firmware.connected = true; emitSample(true); });
  runner.configureCircuit({ sources: config.sources, elements: rawElements(config.elements), switches: config.switches });
  await spawnHost();
}

async function advance(milliseconds) {
  if (!(milliseconds > 0)) return;
  if (runner && firmware.crashed) {
    const target = runner.fixture.nowMs + milliseconds;
    runner.fixture.stepFor(target - runner.fixture.electricalMs, false);
    runner.fixture.nowMs = target;
    receiveSample(runner.fixture.snapshot());
  } else if (runner) runner.setHorizon(runner.fixture.nowMs + milliseconds);
  else passive.advance(milliseconds);
  emitTimeline();
  emitSample();
}

function tick() {
  if (shuttingDown || speed === 0) return;
  const wall = Date.now();
  const elapsed = Math.max(0, wall - lastWall);
  lastWall = wall;
  if (speed === 'max') {
    advance(100).catch(reportError);
    return;
  }
  fractionalMs += elapsed * speed;
  const whole = Math.floor(fractionalMs);
  fractionalMs -= whole;
  if (whole) advance(whole).catch(reportError);
}

function reportError(error) {
  speed = 0;
  post('error', { message: error.message, stack: error.stack });
}

async function configure(next) {
  config = validateConfig(next);
  const raw = rawElements(config.elements);
  if (runner) runner.configureCircuit({ sources: config.sources, elements: raw, switches: config.switches });
  else passive.configure();
  emitTimeline();
  emitSample(true);
}

async function crashFirmware() {
  if (!runner) return;
  intentionalExit = true;
  if (child) {
    const current = child;
    current.kill('SIGKILL');
    await new Promise((resolve) => current.once('exit', resolve));
  }
  runner.fixture.crash(0);
  receiveSample(runner.fixture.snapshot());
  firmware.connected = false;
  firmware.crashed = true;
  firmware.outputs = { PTT_DRV: false, DOOR_DRV: false, MUTE_DRV: false, P4_ISO: false };
  post('status', { status: 'crashed', detail: 'firmware program drivers removed' });
  emitSample(true);
}

async function rebootFirmware() {
  if (!runner) return;
  await crashFirmware();
  runner.fixture.rebootProgram();
  receiveSample(runner.fixture.snapshot());
  await spawnHost();
  post('status', { status: 'rebooting', detail: 'physical circuit state preserved' });
}

async function handle(message) {
  if (message.type === 'speed') {
    if (![0, 1, 10, 'max'].includes(message.value)) throw new Error('speed must be 0, 1, 10 or max');
    speed = message.value;
    lastWall = Date.now();
    fractionalMs = 0;
    post('status', { status: speed === 0 ? 'paused' : 'running', speed });
  } else if (message.type === 'step') {
    if (speed !== 0) throw new Error('single-step requires paused simulation');
    await advance(1);
    emitSample(true);
  } else if (message.type === 'configure') {
    await configure(message.config);
  } else if (message.type === 'command') {
    if (!runner || firmware.crashed) throw new Error('firmware is not running');
    runner.queueCommand(message.command);
    emitTimeline();
  } else if (message.type === 'crash') {
    await crashFirmware();
  } else if (message.type === 'reboot') {
    await rebootFirmware();
  } else if (message.type === 'snapshot') {
    emitSample(true);
  } else if (message.type === 'shutdown') {
    shuttingDown = true;
    intentionalExit = true;
    if (child) {
      const current = child;
      current.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => current.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      if (child === current) current.kill('SIGKILL');
    }
    await runner?.close().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
    process.exit(0);
  } else throw new Error(`unknown worker action ${message.type}`);
}

parentPort.on('message', (message) => handle(message).catch(reportError));

try {
  if (board === 'doorbell') await initDoorbell();
  else {
    passive = new PassiveCircuit();
    emitSample(true);
  }
  post('ready', { board, config, capabilities: { firmware: board === 'doorbell', speeds: [0, 1, 10, 'max'] } });
  setInterval(tick, 16).unref();
  setInterval(() => emitSample(), 33).unref();
} catch (error) {
  reportError(error);
}
