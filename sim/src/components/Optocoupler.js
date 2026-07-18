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

  // Standard 4-pin: 1 = anode, 2 = cathode (LED); 3 = emitter, 4 = collector.
  // TLP293 GB guarantees 30 % saturated CTR at IF=1 mA, VCE=0.4 V. Use that
  // production minimum specified for the fitted TLP293 GB rank.
  elements(ctx = {}) {
    const P = this.pins;
    const programCtr = ctx.program?.[this.ref]?.ctr ?? 0.30;
    const ctr = this.param(ctx, 'ctr', programCtr);
    const darkCurrent = this.param(ctx, 'darkCurrent', 0);
    const ledIs = this.param(ctx, 'ledIs', 1e-13);
    const ledN = this.param(ctx, 'ledN', 1.9);

    return [{ type: 'OPTO', a: P['1'], b: P['2'], c: P['4'], e: P['3'], Is: ledIs, n: ledN, ctr, darkCurrent, ref: this.ref }];
  }

  // TLP293 abs-max: LED reverse 5 V and collector-emitter 80 V.
  checkSafe(vn) {
    const out = [];
    const V = (p) => vn[this.pins[p]];
    this.chk(out, '1-2', `${this.pins['1']}↔${this.pins['2']}`, V('1') - V('2'), -5, Infinity, 'opto LED reverse 5 V (VR)');
    this.chk(out, '4-3', `${this.pins['4']}↔${this.pins['3']}`, V('4') - V('3'), -7, 80, 'opto collector-emitter 80 V (VCEO)');
    return out;
  }
}
