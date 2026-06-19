import { Component } from './Component.js';
import { netV } from '../engine.js';

export default class Ldo extends Component {
  static kind = 'ic';

  // a regulator: identified by its VIN / VOUT / GND pin functions
  static compatible(c) {
    const fn = c.pinfn || {};
    let vin = false;
    let vout = false;
    let gnd = false;

    for (const p in fn) {
      if (/^VIN/.test(fn[p])) vin = true;
      if (/^VOUT/.test(fn[p])) vout = true;
      if (/^GND/.test(fn[p])) gnd = true;
    }

    return vin && vout && gnd;
  }

  elements() {
    const pinOf = (re) => {
      for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p;
      return null;
    };
    const pvin = pinOf(/^VIN/),
      pvout = pinOf(/^VOUT/),
      pgnd = pinOf(/^GND/);
    const vin = pvin && this.pins[pvin],
      vout = pvout && this.pins[pvout],
      gnd = pgnd && this.pins[pgnd];

    if (vin == null || vout == null || gnd == null) return [];

    // regulated output (target from the output net name, e.g. "+3V3" -> 3.3 V); 0.3 V dropout. pinVin/
    // pinVout let the trace-flow place the LDO's pass-through current (I_in ~ I_out) on the right pads.
    return [{ type: 'LDO', vin, vout, gnd, vreg: netV(vout) || 3.3, drop: 0.3, ref: this.ref, pinVin: pvin, pinVout: pvout }];
  }
}
