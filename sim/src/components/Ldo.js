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
    const vin = this.byFn(/^VIN/);
    const vout = this.byFn(/^VOUT/);
    const gnd = this.byFn(/^GND/);

    if (vin == null || vout == null || gnd == null) return [];

    // ideal regulated output (target from the output net name, e.g. "+3V3" -> 3.3 V); 0.3 V dropout
    return [{ type: 'LDO', vin, vout, gnd, vreg: netV(vout) || 3.3, drop: 0.3, ref: this.ref }];
  }
}
