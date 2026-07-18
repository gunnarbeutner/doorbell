import { EventEmitter } from 'node:events';
import net from 'node:net';

import { importNetlist } from '../src/import.js';
import { buildElements, defaultSwitchState } from '../src/components/index.js';
import { createStepper, gndOf } from '../src/engine.js';

export const PROTOCOL_VERSION = 1;

const GPIO_TO_SIGNAL = Object.freeze({
  4: 'K5_SENSE_N',
  5: 'VBUS_F_ADC',
  9: 'PTT_DRV',
  10: 'DOOR_DRV',
  11: 'MUTE_DRV',
  12: 'P4_SENSE_N',
  13: 'P5_SENSE_N',
  47: 'PTT_SENSE_N',
  48: 'P4_ISO',
});

const EXPECTED_U1 = Object.freeze({
  4: '/K5_SENSE_N',
  5: '/VBUS_F_ADC',
  17: '/PTT_DRV',
  18: '/DOOR_DRV',
  19: '/MUTE_DRV',
  20: '/P4_SENSE_N',
  21: '/P5_SENSE_N',
  24: '/PTT_SENSE_N',
  25: '/P4_ISO',
});

const IMPORTANT_NETS = ['/P2', '/P3', '/P4', '/P5', '/K5_LATCH', '/K6_RET', '/CHIME_POS'];

let cachedHeadNetlist;
let cachedDefaultState;

function liveHeadNetlist() {
  // Every suite invocation imports HEAD from KiCad. Reusing the immutable result within that
  // invocation avoids launching kicad-cli once per fresh firmware scenario.
  cachedHeadNetlist ??= importNetlist();
  return cachedHeadNetlist;
}

function source(value = 0) {
  if (value === null) return { kind: 'off', value: 0, offset: 0, amplitude: 0, frequency: 0 };
  return { kind: 'dc', value, offset: 0, amplitude: 0, frequency: 0 };
}

export class HeadCircuitFixture {
  constructor({ startMs = 0, timeline = [] } = {}) {
    this.netlist = liveHeadNetlist();
    this.validateHeadMapping();
    this.timeline = timeline;
    this.startMs = Number(startMs);
    this.nowMs = Number(startMs);
    this.electricalMs = Number(startMs);
    this.electricalSeconds = 0;
    this.fineUntilMs = this.nowMs;
    this.dynamicUntilMs = this.nowMs;
    this.doorRecoveryUntilMs = this.nowMs;
    this.externalToneActive = false;
    this.outputs = { PTT_DRV: false, DOOR_DRV: false, MUTE_DRV: false, P4_ISO: false };
    this.mediaActive = false;
    this.sources = {
      P2: source(12),
      P4: source(null),
      P5: source(null),
      VBUS: source(5),
    };
    this.switches = { ...defaultSwitchState(this.netlist), SW3: false, SW4: false };
    this.programPresent = true;
    this.lastInputMask = null;
    this.indeterminateSince = {};
    this.lastElectrical = {};
    this.rebuild(0.0002, cachedDefaultState);
    if (cachedDefaultState === undefined) {
      this.fineUntilMs = this.nowMs + 40;
      this.dynamicUntilMs = this.fineUntilMs;
      this.stepFor(40, false);
      cachedDefaultState = this.stepper.extractState();
      // Rail/codec settling is fixture initialization, not firmware-visible elapsed time.
      this.electricalMs = this.startMs;
      this.electricalSeconds = 0;
    }
    this.fineUntilMs = this.nowMs;
    this.dynamicUntilMs = this.nowMs;
    this.doorRecoveryUntilMs = this.nowMs;
    this.timeline.length = 0;
    this.lastElectrical = {};
    this.recordElectrical(true);
    this.lastInputMask = this.readInputs().mask;
  }

  validateHeadMapping() {
    const u1 = this.netlist.components.find((component) => component.ref === 'U1');
    if (!u1) throw new Error('HEAD mapping: U1 is missing');
    for (const [pin, expected] of Object.entries(EXPECTED_U1)) {
      if (u1.pins[pin] !== expected)
        throw new Error(`HEAD mapping: U1 pin ${pin} must be ${expected}, got ${u1.pins[pin] ?? '(missing)'}`);
    }
    const j2 = this.netlist.components.find((component) => component.ref === 'J2');
    const expectedBus = { 1: 'GND', 2: '/P2', 3: '/P3', 4: '/P4', 5: '/P5' };
    for (const [pin, expected] of Object.entries(expectedBus))
      if (j2?.pins[pin] !== expected)
        throw new Error(`HEAD mapping: J2.${pin} must be ${expected}, got ${j2?.pins[pin] ?? '(missing)'}`);
  }

  validateHello(tokens) {
    const advertised = Object.fromEntries(tokens.map((token) => token.split('=')));
    for (const [pin, signal] of Object.entries(GPIO_TO_SIGNAL)) {
      if (advertised[signal] !== pin)
        throw new Error(`HELLO mapping mismatch for ${signal}: expected GPIO${pin}, got ${advertised[signal] ?? 'missing'}`);
    }
  }

  valueAt(name) {
    const spec = this.sources[name];
    if (spec.kind === 'tone')
      return spec.offset + spec.amplitude * Math.sin(2 * Math.PI * spec.frequency * this.electricalSeconds);
    if (spec.kind === 'pulse') {
      const elapsedMs = (this.electricalSeconds - spec.startedSeconds) * 1000;
      if (elapsedMs < spec.delayMs) return spec.low;
      const activeMs = elapsedMs - spec.delayMs;
      if (spec.count !== null && activeMs >= spec.count * spec.periodMs) return spec.low;
      return activeMs % spec.periodMs < spec.widthMs ? spec.high : spec.low;
    }
    if (spec.kind === 'captured') {
      const elapsedMs = Math.max(0, (this.electricalSeconds - spec.startedSeconds) * 1000);
      const last = spec.values.length - 1;
      const position = Math.min(last, elapsedMs / spec.dtMs);
      const index = Math.floor(position);
      const fraction = position - index;
      return spec.values[index] + fraction * ((spec.values[index + 1] ?? spec.values[index]) - spec.values[index]);
    }
    return spec.value;
  }

  refreshExternalWave() {
    const waves = Object.values(this.sources).filter((item) =>
      item.kind === 'tone' || item.kind === 'pulse' || item.kind === 'captured');
    this.externalToneActive = waves.length !== 0;
    this.externalStepSeconds = Math.min(0.00025, ...waves.map((item) => {
      if (item.kind === 'captured') return item.dtMs / 1000;
      if (item.kind === 'pulse')
        return Math.max(0.00002, Math.min(item.widthMs, item.periodMs - item.widthMs) / 4000);
      return 1 / (item.frequency * 6);
    }));
  }

  program() {
    if (!this.programPresent) return {};
    return {
      U1: {
        '/PTT_DRV': () => (this.outputs.PTT_DRV ? 3.3 : 0),
        '/DOOR_DRV': () => (this.outputs.DOOR_DRV ? 3.3 : 0),
        '/MUTE_DRV': () => (this.outputs.MUTE_DRV ? 3.3 : 0),
        '/P4_ISO': () => (this.outputs.P4_ISO ? 3.3 : 0),
      },
      U3: {
        out: {
          // A bounded, non-harmonic-to-the-1 ms-step codec representative. It is not a TV20/S
          // acoustic model; it only exercises the board's TX coupling while firmware owns media.
          p: () => 1.65 + (this.mediaActive ? 0.35 * Math.sin(2 * Math.PI * 333 * this.electricalSeconds) : 0),
          n: () => 1.65,
        },
      },
    };
  }

  rebuild(dt, seed = this.stepper?.extractState()) {
    this.dt = dt;
    const connectedBusSources = ['P2', 'P4', 'P5'].filter((name) => this.sources[name].kind !== 'off');
    const extra = connectedBusSources.map((name) => ({
      type: 'R',
      a: `/TEST_${name}_SOURCE`,
      b: `/${name}`,
      value: 90,
      ref: `TEST_${name}_SOURCE_R`,
    }));
    const elements = buildElements(this.netlist, {
      switchState: this.switches,
      program: this.program(),
      extra,
    });
    const sources = [{ net: '/VBUS', vf: () => this.valueAt('VBUS') },
      ...connectedBusSources.map((name) => ({ net: `/TEST_${name}_SOURCE`, vf: () => this.valueAt(name) }))];
    this.stepper = createStepper(elements, sources, gndOf(this.netlist), dt, seed);
  }

  ensureStepSize() {
    // Resolve topology edges finely, then the remainder of the bounded physical transient at a
    // medium step. Tone stimuli retain enough samples per cycle to locate GPIO threshold crossings.
    const wanted = this.electricalMs < this.fineUntilMs
      ? 0.00002
      : this.externalToneActive ? this.externalStepSeconds
        : this.electricalMs < this.dynamicUntilMs ? 0.0005
          : 0.010;
    if (wanted !== this.dt) this.rebuild(wanted);
  }

  stepFor(milliseconds, detectInputs = true) {
    const target = this.electricalMs + milliseconds;
    while (this.electricalMs + 1e-9 < target) {
      // Once a bounded transient reaches steady state there is no new electrical information to
      // solve. Jumping the circuit clock preserves policy timing while avoiding thousands of
      // identical nonlinear solves during long WAV and 30-second timeout scenarios.
      const doorNeedsTime = (this.programPresent && this.outputs.DOOR_DRV) ||
        this.electricalMs < this.doorRecoveryUntilMs;
      if (!this.externalToneActive && !doorNeedsTime && this.electricalMs >= this.dynamicUntilMs) {
        this.electricalSeconds += (target - this.electricalMs) / 1000;
        this.electricalMs = target;
        break;
      }
      this.ensureStepSize();
      const activeTarget = this.externalToneActive || doorNeedsTime
        ? target : Math.min(target, this.dynamicUntilMs);
      const stepMs = Math.min(this.dt * 1000, activeTarget - this.electricalMs);
      if (Math.abs(stepMs / 1000 - this.dt) > 1e-12) this.rebuild(stepMs / 1000);
      this.electricalSeconds += stepMs / 1000;
      this.electricalMs += stepMs;
      this.stepper.step(this.electricalSeconds);
      this.recordElectrical(false);
      if (detectInputs) {
        const { mask } = this.readInputs(false);
        if (this.lastInputMask !== null && mask !== this.lastInputMask) {
          this.lastInputMask = mask;
          return Math.ceil(this.electricalMs - 1e-9);
        }
        this.lastInputMask = mask;
      }
    }
    return null;
  }

  voltage(netName) {
    if (netName === this.stepper.gnd) return 0;
    const index = this.stepper.ni[netName];
    return index === undefined ? Number.NaN : this.stepper.vn[index];
  }

  digital(netName, fallback, strict) {
    const volts = this.voltage(netName);
    if (volts <= 0.825) {
      delete this.indeterminateSince[netName];
      return false;
    }
    if (volts >= 2.475) {
      delete this.indeterminateSince[netName];
      return true;
    }
    if (fallback !== undefined) {
      if (!strict) return fallback;
      const since = this.indeterminateSince[netName] ?? this.nowMs;
      this.indeterminateSince[netName] = since;
      if (this.nowMs - since < 20) return fallback;
    }
    throw new Error(`${netName} is in the ESP32 indeterminate region at ${volts.toFixed(3)} V`);
  }

  readInputs(strict = true) {
    let mask = 0;
    const before = this.lastInputMask ?? 0x0F;
    if (this.digital('/P4_SENSE_N', (before & 0x01) !== 0, strict)) mask |= 0x01;
    if (this.digital('/P5_SENSE_N', (before & 0x02) !== 0, strict)) mask |= 0x02;
    if (this.digital('/K5_SENSE_N', (before & 0x04) !== 0, strict)) mask |= 0x04;
    if (this.digital('/PTT_SENSE_N', (before & 0x08) !== 0, strict)) mask |= 0x08;
    const adcMv = Math.max(0, Math.round(this.voltage('/VBUS_F_ADC') * 1000));
    return { mask, adcMv };
  }

  setOutput(signal, value, at = this.nowMs) {
    if (!(signal in this.outputs)) throw new Error(`unknown firmware output ${signal}`);
    if (this.outputs[signal] === value) return;
    this.outputs[signal] = value;
    if (signal !== 'DOOR_DRV')
      this.fineUntilMs = Math.max(this.fineUntilMs, Number(at) + 2);
    this.dynamicUntilMs = Math.max(this.dynamicUntilMs, Number(at) + (signal === 'DOOR_DRV' ? 60 : 30));
    if (signal === 'DOOR_DRV' && !value)
      this.doorRecoveryUntilMs = Math.max(this.doorRecoveryUntilMs, Number(at) + 500);
  }

  setMedia(active, at = this.nowMs) {
    if (this.mediaActive === active) return;
    this.mediaActive = active;
    this.fineUntilMs = Math.max(this.fineUntilMs, Number(at) + 5);
    // Exercise the bounded codec tone for longer than the apartment-ring qualification interval;
    // once its masked behavior is established, long file duration is policy-only time.
    this.dynamicUntilMs = Math.max(this.dynamicUntilMs, Number(at) + (active ? 160 : 20));
  }

  applyEvent(event) {
    if (event.type === 'source') {
      this.sources[event.line] = source(event.value);
      this.refreshExternalWave();
      this.rebuild(0.00002);
      this.fineUntilMs = Math.max(this.fineUntilMs, event.at + 8);
      this.dynamicUntilMs = Math.max(this.dynamicUntilMs, event.at + 100);
    } else if (event.type === 'tone') {
      this.sources[event.line] = {
        kind: 'tone',
        offset: event.offset ?? 0,
        amplitude: event.amplitude,
        frequency: event.frequency,
      };
      this.refreshExternalWave();
      this.rebuild(0.00002);
    } else if (event.type === 'pulse') {
      if (!(event.periodMs > 0 && event.widthMs > 0 && event.widthMs < event.periodMs))
        throw new Error('pulse stimulus requires 0 < widthMs < periodMs');
      this.sources[event.line] = {
        kind: 'pulse',
        low: event.low ?? 0,
        high: event.high,
        periodMs: event.periodMs,
        widthMs: event.widthMs,
        delayMs: event.delayMs ?? 0,
        count: event.count ?? null,
        startedSeconds: this.electricalSeconds,
      };
      this.refreshExternalWave();
      this.rebuild(0.00002);
    } else if (event.type === 'captured') {
      if (!(event.dtMs > 0) || !Array.isArray(event.values) || event.values.length < 2)
        throw new Error('captured stimulus requires dtMs > 0 and at least two values');
      this.sources[event.line] = {
        kind: 'captured',
        dtMs: event.dtMs,
        values: event.values,
        startedSeconds: this.electricalSeconds,
      };
      this.refreshExternalWave();
      this.rebuild(0.00002);
    } else if (event.type === 'switch') {
      this.switches[event.ref] = event.closed;
      this.rebuild(0.00002);
      this.fineUntilMs = Math.max(this.fineUntilMs, event.at + 8);
      this.dynamicUntilMs = Math.max(this.dynamicUntilMs, event.at + 100);
    }
    const timelineEvent = event.type === 'captured'
      ? { ...event, values: `${event.values.length} samples` }
      : { ...event };
    this.timeline.push({ at: event.at, type: 'stimulus', event: timelineEvent });
  }

  recordElectrical(force) {
    const state = this.stepper.extractState();
    const current = {};
    for (const netName of IMPORTANT_NETS) current[netName] = this.voltage(netName);
    for (const [ref, value] of Object.entries(state.relays)) current[ref] = value;
    for (const [ref, value] of Object.entries(state.ssrs)) current[ref] = value;
    for (const [key, value] of Object.entries(current)) {
      const before = this.lastElectrical[key];
      const changed = typeof value === 'boolean' ? before !== value : before === undefined || Math.abs(before - value) > 0.5;
      // The stimulus entry plus raw GPIO transitions describe audio-rate activity compactly; do not
      // expand every captured-tone sample into tens of thousands of analog timeline rows.
      const suppressToneSample = this.externalToneActive && typeof value === 'number' && !force;
      if ((force || changed) && !suppressToneSample)
        this.timeline.push({ at: Math.ceil(this.electricalMs), type: 'electrical', name: key,
          value: typeof value === 'number' ? Number(value.toFixed(3)) : value });
    }
    this.lastElectrical = current;
  }

  advanceTo(targetMs) {
    const target = Number(targetMs);
    if (target < this.nowMs) throw new Error(`time moved backwards: ${target} < ${this.nowMs}`);
    const crossing = this.stepFor(target - this.electricalMs, true);
    if (crossing !== null && crossing <= target) {
      // Multiple audio-rate GPIO crossings may occur inside one integer millisecond. Returning the
      // same protocol timestamp is valid because electrical state has advanced; artificially adding
      // 1 ms per crossing would let virtual time outrun the circuit and skip external events.
      this.nowMs = Math.max(this.nowMs, crossing);
      return { at: this.nowMs, reason: 'input' };
    }
    this.nowMs = target;
    return { at: target, reason: 'deadline' };
  }

  crash() {
    this.programPresent = false;
    this.mediaActive = false;
    this.externalToneActive = false;
    this.fineUntilMs = Math.max(this.fineUntilMs, this.nowMs + 2);
    this.dynamicUntilMs = Math.max(this.dynamicUntilMs, this.nowMs + 20);
    this.rebuild(0.00002);
    this.stepFor(100, false);
    this.recordElectrical(true);
  }
}

export class FirmwareCircuitRunner extends EventEmitter {
  constructor({ socketPath, startMs = 0, events = [], slowdownMs = 0,
    responseVersion = PROTOCOL_VERSION } = {}) {
    super();
    this.socketPath = socketPath;
    this.events = [...events].sort((a, b) => a.at - b.at);
    this.slowdownMs = slowdownMs;
    this.responseVersion = responseVersion;
    this.timeline = [];
    this.fixture = new HeadCircuitFixture({ startMs, timeline: this.timeline });
    this.pendingCommands = [];
    this.failure = null;
    this.connected = false;
  }

  async listen() {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  accept(socket) {
    if (this.connected) {
      socket.destroy(new Error('only one firmware process may connect'));
      return;
    }
    this.connected = true;
    this.socket = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.handleLine(line).catch((error) => this.fail(error));
      }
    });
    socket.on('close', () => this.emit('disconnect'));
    socket.on('error', (error) => this.fail(error));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.socket?.destroy();
    this.emit('failure', this.failure);
  }

  parseVersion(tokens) {
    if (Number(tokens[1]) !== PROTOCOL_VERSION)
      throw new Error(`protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${tokens[1]}`);
  }

  processEventsThrough(at) {
    while (this.events.length && this.events[0].at <= at) {
      const event = this.events.shift();
      if (event.type === 'command') {
        this.pendingCommands.push(event.command);
        this.timeline.push({ at: event.at, type: 'command', command: event.command });
      } else {
        this.fixture.applyEvent(event);
      }
    }
  }

  nextEventAt(deadline) {
    return this.events.length && this.events[0].at <= deadline ? this.events[0].at : deadline;
  }

  sendAt(reason) {
    const { mask, adcMv } = this.fixture.readInputs();
    const commands = this.pendingCommands.splice(0);
    if (reason === 'boot' || reason === 'external' || commands.length ||
        (reason === 'input' && !this.fixture.externalToneActive))
      this.timeline.push({ at: Math.trunc(this.fixture.nowMs), type: 'at', reason, mask, adcMv });
    const suffix = commands.length ? ` ${commands.join(' ')}` : '';
    this.socket.write(`AT ${this.responseVersion} ${Math.trunc(this.fixture.nowMs)} ${mask} ${adcMv} ${reason} ${commands.length}${suffix}\n`);
  }

  async handleLine(line) {
    if (this.slowdownMs) await new Promise((resolve) => setTimeout(resolve, this.slowdownMs));
    const tokens = line.trim().split(/\s+/);
    const kind = tokens[0];
    this.parseVersion(tokens);
    if (kind === 'HELLO') {
      this.fixture.validateHello(tokens.slice(2));
      this.processEventsThrough(this.fixture.nowMs);
      this.sendAt('boot');
      return;
    }
    if (kind === 'WRITE') {
      const [, , at, sequence, pinText, valueText] = tokens;
      const pin = Number(pinText);
      const signal = GPIO_TO_SIGNAL[pin];
      if (!['PTT_DRV', 'DOOR_DRV', 'MUTE_DRV', 'P4_ISO'].includes(signal))
        throw new Error(`WRITE targets non-output GPIO${pin}`);
      const value = valueText === '1';
      this.fixture.setOutput(signal, value, Number(at));
      this.timeline.push({ at: Number(at), type: 'write', sequence: Number(sequence), signal, value });
      return;
    }
    if (kind === 'MEDIA') {
      const [, , at, state, name, duration] = tokens;
      this.fixture.setMedia(state === 'START', Number(at));
      this.timeline.push({ at: Number(at), type: 'media', state, name, duration: Number(duration) });
      return;
    }
    if (kind === 'EMIT') {
      const [, , at, name, value] = tokens;
      this.timeline.push({ at: Number(at), type: 'entity', name, value: value === '1' });
      return;
    }
    if (kind === 'ADVANCE') {
      const now = Number(tokens[2]);
      const deadline = Number(tokens[3]);
      if (now !== this.fixture.nowMs)
        throw new Error(`ADVANCE now mismatch: host=${now}, runner=${this.fixture.nowMs}`);
      const boundary = this.nextEventAt(deadline);
      const result = this.fixture.advanceTo(boundary);
      if (result.reason === 'input') {
        this.sendAt('input');
        return;
      }
      if (boundary < deadline || (this.events.length && this.events[0].at === boundary)) {
        this.processEventsThrough(boundary);
        this.sendAt('external');
      } else {
        this.sendAt('deadline');
      }
      return;
    }
    throw new Error(`unknown host message ${kind}`);
  }

  async close() {
    this.socket?.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  compactTimeline() {
    return this.timeline.map((item) => JSON.stringify(item)).join('\n');
  }
}
