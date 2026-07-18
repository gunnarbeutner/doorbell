import { Component } from './Component.js';
import { netV } from '../engine.js';

// pin-function matchers: accept both "VIN/VOUT" (e.g. SGM2212) and bare "IN/OUT" (e.g. LP5907). Anchored
// to a whole token ((V)IN/(V)OUT then "_" or end-of-string) so they can't catch CH1_IN/CH1_OUT (the USB
// ESD array) or names like INT/OUTPUT.
const RE_VIN = /^V?IN(_|$)/;
const RE_VOUT = /^V?OUT(_|$)/;
const RE_GND = /^GND/;

export default class Ldo extends Component {
  static kind = 'ic';

  // a linear regulator: identified by its (V)IN / (V)OUT / GND pin functions
  static compatible(c) {
    const fn = c.pinfn || {};
    let vin = false;
    let vout = false;
    let gnd = false;

    for (const p in fn) {
      if (RE_VIN.test(fn[p])) vin = true;
      if (RE_VOUT.test(fn[p])) vout = true;
      if (RE_GND.test(fn[p])) gnd = true;
    }

    return vin && vout && gnd;
  }

  // VIN absolute maximum, per part — the input over-voltage the rail must never exceed.
  vinAbsMax() {
    if (/LP5907/i.test(`${this.lib} ${this.value}`)) return 6; // LP5907 (audio AVDD LDO): VIN abs-max 6 V
    return 22; // SGM2212 (main +3V3 LDO): VIN abs-max 22 V
  }

  elements(ctx) {
    const pinOf = (re) => {
      for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p;
      return null;
    };
    const pvin = pinOf(RE_VIN),
      pvout = pinOf(RE_VOUT),
      pgnd = pinOf(RE_GND);
    const vin = pvin && this.pins[pvin],
      vout = pvout && this.pins[pvout],
      gnd = pgnd && this.pins[pgnd];

    if (vin == null || vout == null || gnd == null) return [];

    // regulated output (target from the output net name, e.g. "AVDD_PRE"/"+3V3" -> 3.3 V); 0.3 V dropout.
    // pinVin/pinVout let the trace-flow place the LDO's pass-through current (I_in ~ I_out) on the right pads.
    const vreg = this.param(ctx, 'vreg', netV(vout) || 3.3);
    const drop = this.param(ctx, 'drop', 0.3);
    return [{ type: 'LDO', vin, vout, gnd, vreg, drop, ref: this.ref, pinVin: pvin, pinVout: pvout }];
  }

  // VIN abs-max is per part (SGM2212 22 V, LP5907 6 V); the output must never sit above the input.
  checkSafe(vn) {
    const out = [];
    const pinOf = (re) => { for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p; return null; };
    const vinP = pinOf(RE_VIN), voutP = pinOf(RE_VOUT);
    const vin = vn[this.pins[vinP]], vout = vn[this.pins[voutP]];
    const vmax = this.vinAbsMax();
    this.chk(out, this.pinfn[vinP], this.pins[vinP], vin, -0.3, vmax, `LDO VIN abs-max ${vmax} V`);
    if (Number.isFinite(vin) && Number.isFinite(vout))
      this.chk(out, 'VIN-VOUT', `${this.pins[vinP]}↔${this.pins[voutP]}`, vin - vout, -0.3, Infinity, 'LDO output must not exceed input');
    return out;
  }
}
