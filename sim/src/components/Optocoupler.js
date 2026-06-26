import { Component } from './Component.js';

export default class Optocoupler extends Component {
  static kind = 'optocoupler';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    const isOpto =
      cat.includes('optocoupler') ||
      name.startsWith('ltv') ||
      name.includes('pc817') ||
      Component.refPre(c.ref) === 'OC';

    const P = c.pins || {};

    return isOpto && P['1'] != null && P['2'] != null && P['3'] != null && P['4'] != null;
  }

  // standard 4-pin: 1 = anode, 2 = cathode (LED); 3 = emitter, 4 = collector.
  // PC817 / LTV-217: IR LED (~1.1 V), CTR ~100 %
  elements() {
    const P = this.pins;

    return [{ type: 'OPTO', a: P['1'], b: P['2'], c: P['4'], e: P['3'], Is: 1e-13, n: 1.9, ctr: 1.0, ref: this.ref }];
  }

  // PC817/LTV-217 abs-max: LED reverse 6 V (VR); collector-emitter 70 V (VCEO; BVCEO >=80 V).
  checkSafe(vn) {
    const out = [];
    const V = (p) => vn[this.pins[p]];
    this.chk(out, '1-2', `${this.pins['1']}↔${this.pins['2']}`, V('1') - V('2'), -6, Infinity, 'opto LED reverse 6 V (VR)');
    this.chk(out, '4-3', `${this.pins['4']}↔${this.pins['3']}`, V('4') - V('3'), -7, 70, 'opto collector-emitter 70 V (VCEO)');
    return out;
  }
}
