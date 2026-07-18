import { buildElements, defaultSwitchState } from '../components/index.js';
import { TV20S_CALIBRATION, validateTv20sCalibration } from './calibration.js';

const PREFIX = 'TV20S_NEIGHBOUR_';
const PRIVATE_P4 = '/TV20S_NEIGHBOUR_P4';
const PRIVATE_P5 = '/TV20S_NEIGHBOUR_P5';

export class UnsupportedTv20sBehavior extends Error {
  constructor(code, detail, neededEvidence) {
    super(`unsupported TV20/S behavior ${code}: ${detail}${neededEvidence ? `; needs ${neededEvidence}` : ''}`);
    this.name = 'UnsupportedTv20sBehavior';
    this.code = code;
    this.neededEvidence = neededEvidence;
  }
}

function mapNeighbourNet(net, ground) {
  if (net === '/P1') return ground;
  if (net === '/P2' || net === '/P3') return net;
  if (net === '/P4') return PRIVATE_P4;
  if (net === '/P5') return PRIVATE_P5;
  return `${PREFIX}${String(net).replace(/^\//, '')}`;
}

function neighbourElements(referenceNetlist, ground, doorClosed) {
  const switchState = { ...defaultSwitchState(referenceNetlist), S1: doorClosed, S2: false };
  return buildElements(referenceNetlist, { switchState }).map((element) => {
    const copy = { ...element };
    for (const key of ['a', 'b', 'g', 'd', 's', 'c', 'e', 'vin', 'vout', 'gnd', 'coilA', 'coilB'])
      if (copy[key] != null) copy[key] = mapNeighbourNet(copy[key], ground);
    if (copy.ref) copy.ref = PREFIX + copy.ref;
    if (copy.padRef) copy.padRef = PREFIX + copy.padRef;
    return copy;
  });
}

const expRise = (elapsedMs, riseMs) => {
  if (elapsedMs <= 0) return 0;
  // The capture reports a 10–90 % rise. A first-order edge has t10-90 = 2.197 tau.
  const tau = riseMs / 2.197;
  return 1 - Math.exp(-elapsedMs / tau);
};

function harmonicWave(seconds, frequency, harmonics) {
  let value = 0;
  for (const harmonic of harmonics)
    value += harmonic.amplitude * Math.sin(2 * Math.PI * frequency * harmonic.multiple * seconds);
  return value;
}

export class Tv20sEnvironment {
  constructor({ startMs = 0, calibration = TV20S_CALIBRATION, referenceNetlist, ground = 'GND' } = {}) {
    validateTv20sCalibration(calibration);
    if (!referenceNetlist) throw new Error('TV20/S environment requires the live WF26 reference netlist');
    this.calibration = calibration;
    this.referenceNetlist = referenceNetlist;
    this.ground = ground;
    this.reset(startMs);
  }

  reset(startMs = 0) {
    this.startMs = Number(startMs);
    this.callOwner = null;
    this.ringStartMs = null;
    this.timeoutStartMs = null;
    this.sessionEndMs = null;
    this.sessionEndReason = null;
    this.floorCallStartMs = null;
    this.neighbourDoorStartMs = null;
    this.neighbourDoorDurationMs = 1000;
    this.directDoorActive = false;
    this.directDoorHadSession = false;
    this.talkActive = false;
    this.doorReleasedMs = null;
    this.lastNowMs = Number(startMs);
    this._ringDriveActive = false;
    this._gongActive = false;
    this._neighbourDoorClosed = false;
    this._timeoutControlled = false;
  }

  atSeconds(seconds) {
    return this.startMs + Number(seconds) * 1000;
  }

  unsupported(code, detail, neededEvidence) {
    throw new UnsupportedTv20sBehavior(code, detail, neededEvidence);
  }

  ringElapsed(nowMs) {
    return this.ringStartMs == null ? Infinity : Number(nowMs) - this.ringStartMs;
  }

  gongActiveAt(nowMs) {
    const elapsed = this.ringElapsed(nowMs);
    return elapsed >= 0 && elapsed < this.calibration.ring.gong_duration_ms;
  }

  ringDriveActiveAt(nowMs) {
    const elapsed = this.ringElapsed(nowMs);
    return elapsed >= 0 && elapsed < this.calibration.ring.pedestal_drive_ms;
  }

  neighbourDoorActiveAt(nowMs) {
    if (this.neighbourDoorStartMs == null) return false;
    const elapsed = Number(nowMs) - this.neighbourDoorStartMs;
    return elapsed >= 0 && elapsed < this.neighbourDoorDurationMs;
  }

  floorActiveAt(nowMs) {
    return this.floorCallStartMs != null && Number(nowMs) >= this.floorCallStartMs;
  }

  timeoutActiveAt(nowMs) {
    if (this.timeoutStartMs == null) return false;
    const elapsed = Number(nowMs) - this.timeoutStartMs;
    return elapsed >= 0 && elapsed < this.calibration.p2.timeout_sink_ms;
  }

  timeoutControlledAt(nowMs) {
    if (this.timeoutStartMs == null) return false;
    const elapsed = Number(nowMs) - this.timeoutStartMs;
    return elapsed >= 0 && elapsed < this.calibration.p2.timeout_sink_ms +
      this.calibration.p2.timeout_recovery_observed_ms;
  }

  p2SourceResistanceAt(nowMs) {
    return this.timeoutControlledAt(nowMs)
      ? this.calibration.p2.timeout_source_resistance_ohm
      : this.calibration.p2.source_resistance_ohm;
  }

  p2SourceAt(nowMs) {
    const c = this.calibration.p2;
    if (this.timeoutStartMs != null) {
      const elapsed = Number(nowMs) - this.timeoutStartMs;
      if (elapsed >= 0 && elapsed < c.timeout_fall_ms) {
        const progress = (1 - Math.exp(-elapsed / c.timeout_fall_tau_ms)) /
          (1 - Math.exp(-c.timeout_fall_ms / c.timeout_fall_tau_ms));
        return c.timeout_terminal_start_v +
          (c.timeout_terminal_plateau_v - c.timeout_terminal_start_v) * progress;
      }
      if (elapsed >= c.timeout_fall_ms && elapsed < c.timeout_sink_ms)
        return c.timeout_terminal_plateau_v;
      if (elapsed >= c.timeout_sink_ms &&
          elapsed < c.timeout_sink_ms + c.timeout_recovery_observed_ms) {
        const recovery = elapsed - c.timeout_sink_ms;
        if (recovery < c.timeout_recovery_snap_ms) {
          const progress = expRise(recovery, c.timeout_recovery_snap_ms);
          const full = expRise(c.timeout_recovery_snap_ms, c.timeout_recovery_snap_ms);
          return c.timeout_terminal_plateau_v +
            (c.timeout_recovery_snap_v - c.timeout_terminal_plateau_v) * progress / full;
        }
        return c.idle_v - (c.idle_v - c.timeout_recovery_snap_v) *
          Math.exp(-(recovery - c.timeout_recovery_snap_ms) / c.timeout_recovery_tau_ms);
      }
    }
    if (this.doorReleasedMs != null) {
      const elapsed = Number(nowMs) - this.doorReleasedMs;
      if (elapsed >= 0 && elapsed < c.door_recovery_observed_ms) {
        const start = this.directDoorHadSession ? 7.4 : 7.16;
        return c.idle_v - (c.idle_v - start) * Math.exp(-elapsed / c.door_recovery_tau_ms);
      }
    }
    return c.idle_v + this.calibration.ring.gong_source_scale_v * this.gongAt(nowMs);
  }

  gongAt(nowMs) {
    if (!this.gongActiveAt(nowMs)) return 0;
    const elapsedMs = this.ringElapsed(nowMs);
    const elapsedSeconds = elapsedMs / 1000;
    let value = 0;
    for (const strike of this.calibration.ring.strikes) {
      const age = elapsedMs - strike.at_ms;
      if (age < 0) continue;
      value += Math.exp(-age / strike.decay_ms) *
        harmonicWave(elapsedSeconds - strike.at_ms / 1000, strike.frequency_hz, this.calibration.ring.harmonics);
    }
    return value;
  }

  floorAt(nowMs) {
    if (!this.floorActiveAt(nowMs)) return 0;
    const elapsedSeconds = (Number(nowMs) - this.floorCallStartMs) / 1000;
    return this.calibration.floor_call.source_scale_v * harmonicWave(elapsedSeconds,
      this.calibration.floor_call.frequency_hz, this.calibration.floor_call.harmonics);
  }

  apply(action, atMs) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error('TV20/S event requires a finite virtual time');
    if (action === 'own-ring' || action === 'neighbour-ring') {
      if (this.callOwner != null || this.floorActiveAt(at))
        this.unsupported('overlapping-bell-types', `${action} requested while ${this.callOwner || 'floor call'} is active`,
          'a capture of the requested overlap');
      this.callOwner = action === 'own-ring' ? 'local' : 'neighbour';
      this.ringStartMs = at;
      this.timeoutStartMs = at + this.calibration.p2.timeout_after_ring_ms;
      this.sessionEndMs = this.timeoutStartMs + this.calibration.p2.timeout_sink_ms;
      this.sessionEndReason = 'timeout';
      this.doorReleasedMs = null;
      return;
    }
    if (action === 'floor-call-start') {
      if (this.callOwner != null)
        this.unsupported('overlapping-bell-types', 'floor call requested during a front-door call',
          'a simultaneous floor/front call capture');
      this.floorCallStartMs = at;
      return;
    }
    if (action === 'floor-call-stop') {
      this.floorCallStartMs = null;
      return;
    }
    if (action === 'neighbour-door') {
      if (this.callOwner !== 'neighbour')
        this.unsupported('neighbour-door-without-session', 'neighbour handset door requested without its held call',
          'a matching bus capture');
      if (this.gongActiveAt(at))
        this.unsupported('neighbour-door-during-gong',
          'neighbour handset door requested while its gong is active',
          'a neighbour-handset door-during-gong capture');
      this.neighbourDoorStartMs = at;
      this.sessionEndMs = at + this.calibration.p3.neighbour_session_end_after_door_ms;
      this.sessionEndReason = 'neighbour-door';
      return;
    }
    if (action === 'timeout-now') {
      if (this.callOwner == null) throw new Error('TV20/S timeout requires an active call');
      this.timeoutStartMs = at;
      this.sessionEndMs = at + this.calibration.p2.timeout_sink_ms;
      this.sessionEndReason = 'timeout';
      return;
    }
    this.unsupported('unknown-event', `unknown environment action ${action}`);
  }

  syncTime(nowMs) {
    const now = Number(nowMs);
    this.lastNowMs = now;
    const hadSession = this.callOwner != null;
    if (hadSession && this.sessionEndMs != null && now >= this.sessionEndMs) {
      this.callOwner = null;
      if (this.sessionEndReason === 'neighbour-door') this.timeoutStartMs = null;
      this.sessionEndMs = null;
      this.sessionEndReason = null;
    }
    const drive = this.ringDriveActiveAt(now);
    const gong = this.gongActiveAt(now);
    const neighbourDoor = this.neighbourDoorActiveAt(now);
    const timeoutControlled = this.timeoutControlledAt(now);
    const topologyChanged = drive !== this._ringDriveActive || gong !== this._gongActive ||
      neighbourDoor !== this._neighbourDoorClosed || timeoutControlled !== this._timeoutControlled ||
      hadSession !== (this.callOwner != null);
    this._ringDriveActive = drive;
    this._gongActive = gong;
    this._neighbourDoorClosed = neighbourDoor;
    this._timeoutControlled = timeoutControlled;
    return topologyChanged;
  }

  observe({ nowMs, voltage }) {
    const p2 = Number(voltage('/P2'));
    const p3 = Number(voltage('/P3'));
    if (!Number.isFinite(p2) || !Number.isFinite(p3)) return false;
    const classification = this.calibration.p3.terminal_classification;
    const difference = Math.abs(p2 - p3);
    // A newly observed short still needs the calibrated door voltage. Once established, retain it
    // from terminal continuity alone: the own-gong waveform may momentarily pull both shorted lines
    // below the opener threshold without the physical P2-P3 bridge having opened.
    const direct = difference <= classification.door_max_difference_v &&
      (p3 >= classification.door_min_v || this.directDoorActive);
    const intermediate = p3 >= classification.intermediate_min_v && !direct;
    const sink = this.callOwner != null
      ? this.calibration.p3.door_session_sink_ohm
      : this.calibration.p3.door_idle_sink_ohm;
    const inferredBridge = intermediate ? sink * (p2 / p3 - 1) : Infinity;
    const talk = intermediate && inferredBridge >= classification.talk_bridge_range_ohm[0] &&
      inferredBridge <= classification.talk_bridge_range_ohm[1];
    if (intermediate && !talk)
      this.unsupported('intermediate-p2-p3-impedance',
        `P2/P3 imply an uncalibrated ${inferredBridge.toFixed(0)} ohm bridge (${p2.toFixed(2)} V/${p3.toFixed(2)} V)`,
        'a safe impedance sweep locating the TV20/S opener threshold');
    const talkChanged = talk !== this.talkActive;
    this.talkActive = talk;

    if (direct && !this.directDoorActive) {
      // An own-ring auto-open is a composition of calibrated terminal equivalents: the measured
      // local gong/session load and the measured direct door short. It requires no knowledge of
      // which DUT contact made the short. A door action in somebody else's still-ringing session
      // remains uncalibrated and is rejected below.
      if (this.gongActiveAt(nowMs) && this.callOwner !== 'local')
        this.unsupported('foreign-door-during-gong',
          'a direct P2-P3 bridge was made during a non-local gong',
          'a matching door-during-gong capture');
      this.directDoorHadSession = this.callOwner != null;
      this.directDoorActive = true;
      this.doorReleasedMs = null;
      return true;
    }
    if (!direct && this.directDoorActive) {
      this.directDoorActive = false;
      this.doorReleasedMs = Number(nowMs);
      return true;
    }

    // Once the gong and any door bridge are gone, the central unit can observe only whether P2 is
    // still loaded. This deliberately detects the electrical session signature, never a DUT relay.
    if (this.callOwner != null && !this.gongActiveAt(nowMs) && !this.directDoorActive &&
        p2 >= this.calibration.p2.idle_v - this.calibration.p2.session_load_min_drop_v) {
      this.callOwner = null;
      this.timeoutStartMs = null;
      this.sessionEndMs = null;
      this.sessionEndReason = null;
      return true;
    }
    return talkChanged;
  }

  nextEventAt(afterMs, limitMs = Infinity) {
    const candidates = [];
    const add = (value) => {
      if (Number.isFinite(value) && value > Number(afterMs) + 1e-9 && value <= Number(limitMs)) candidates.push(value);
    };
    if (this.ringStartMs != null) {
      add(this.ringStartMs + this.calibration.ring.pedestal_drive_ms);
      add(this.ringStartMs + this.calibration.ring.gong_duration_ms);
    }
    if (this.timeoutStartMs != null) {
      add(this.timeoutStartMs);
      add(this.timeoutStartMs + this.calibration.p2.timeout_fall_ms);
      add(this.timeoutStartMs + this.calibration.p2.timeout_sink_ms);
      add(this.timeoutStartMs + this.calibration.p2.timeout_sink_ms +
        this.calibration.p2.timeout_recovery_snap_ms);
      add(this.timeoutStartMs + this.calibration.p2.timeout_sink_ms + this.calibration.p2.timeout_recovery_observed_ms);
    }
    if (this.neighbourDoorStartMs != null) add(this.neighbourDoorStartMs + this.neighbourDoorDurationMs);
    add(this.sessionEndMs);
    if (this.doorReleasedMs != null) add(this.doorReleasedMs + this.calibration.p2.door_recovery_observed_ms);
    return candidates.length ? Math.min(...candidates) : null;
  }

  hasDynamics(nowMs) {
    if (this.gongActiveAt(nowMs) || this.ringDriveActiveAt(nowMs) || this.floorActiveAt(nowMs) ||
        this.timeoutActiveAt(nowMs) || this.neighbourDoorActiveAt(nowMs)) return true;
    const c = this.calibration.p2;
    if (this.timeoutStartMs != null && Number(nowMs) >= this.timeoutStartMs &&
        Number(nowMs) < this.timeoutStartMs + c.timeout_sink_ms + c.timeout_recovery_observed_ms)
      return true;
    return this.doorReleasedMs != null && Number(nowMs) >= this.doorReleasedMs &&
      Number(nowMs) < this.doorReleasedMs + c.door_recovery_observed_ms;
  }

  extraElements() {
    const extra = neighbourElements(this.referenceNetlist, this.ground, this._neighbourDoorClosed);
    extra.push({
      type: 'R', a: '/TV20S_P2_SOURCE', b: '/P2', value: this.p2SourceResistanceAt(this.lastNowMs),
      ref: 'TV20S_P2_SOURCE_R',
    });
    extra.push({
      type: 'R', a: '/P3', b: this.ground,
      value: this.callOwner != null
        ? this.calibration.p3.door_session_sink_ohm
        : this.calibration.p3.door_idle_sink_ohm,
      ref: 'TV20S_P3_TERMINATION',
    });

    const addRingPort = (suffix, net) => {
      if (this._ringDriveActive) {
        // The timed output is expressed relative to the shared P2 terminal. It begins at 0 V and
        // approaches P2 with the captured rise, so the endpoint load naturally creates the P2 sag.
        extra.push({ type: 'V', a: net, b: '/P2',
          vf: (seconds) => -this.calibration.p2.idle_v *
            (1 - expRise(this.atSeconds(seconds) - this.ringStartMs, this.calibration.ring.pedestal_rise_ms)),
          name: `TV20S_${suffix}_RING_V`, ref: `TV20S_${suffix}_RING_V` });
      }
    };
    if (this.callOwner === 'local') addRingPort('LOCAL', '/P4');
    if (this.callOwner === 'neighbour') addRingPort('NEIGHBOUR', PRIVATE_P4);

    if (this.floorActiveAt(this.lastNowMs)) {
      extra.push({ type: 'V', a: '/TV20S_FLOOR_SOURCE', b: this.ground,
        vf: (seconds) => this.floorAt(this.atSeconds(seconds)), name: 'TV20S_FLOOR_V', ref: 'TV20S_FLOOR_V' });
      extra.push({ type: 'R', a: '/TV20S_FLOOR_SOURCE', b: '/P5',
        value: this.calibration.floor_call.source_resistance_ohm, ref: 'TV20S_FLOOR_SOURCE_R' });
    }
    return extra;
  }

  sources() {
    const result = [{ net: '/TV20S_P2_SOURCE', vf: (seconds) => this.p2SourceAt(this.atSeconds(seconds)) }];
    return result;
  }

  snapshot(nowMs = this.lastNowMs) {
    const phase = this.directDoorActive ? 'door'
      : this.timeoutActiveAt(nowMs) ? 'timeout'
        : this.gongActiveAt(nowMs) ? 'ring-gong'
          : this.talkActive ? 'talk'
            : this.callOwner ? 'held' : this.floorActiveAt(nowMs) ? 'floor-call' : 'idle';
    return {
      mode: 'tv20s', calibration: this.calibration.id, phase, callOwner: this.callOwner,
      floorCall: this.floorActiveAt(nowMs), directDoor: this.directDoorActive, talk: this.talkActive,
      supported: [...this.calibration.supported], unsupported: [...this.calibration.unsupported],
    };
  }
}
