import { Component } from './Component.js';

export default class Relay extends Component {
  static kind = 'relay';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);
    const hasCoil = Object.values(c.pinfn || {}).some((f) => /^coil/i.test(f));
    return cat.includes('relay') || name.includes('g6k') || name.includes('hjr') || hasCoil;
  }

  get role() {
    return 'relay'; // coil-driven, read-only in the panel
  }

  pinout() {
    // Omron G6K-2F has no pin functions in its symbol -> hard-coded DPDT numbering
    if (/g6k/i.test(this.lib)) {
      return {
        coil: ['1', '8'],
        contacts: [
          { com: '3', nc: '2', no: '4' },
          { com: '6', nc: '7', no: '5' },
        ],
      };
    }
    // otherwise read the symbol's pin functions (coil / COM / NO / NC), e.g. HJR-4102
    // KiCad suffixes the pin number onto the function (e.g. "coil_5", "COM_1"), so match the prefix
    const fnPins = (re) => Object.keys(this.pins).filter((p) => re.test(this.pinfn[p] || ''));
    const coil = fnPins(/^coil/i),
      com = fnPins(/^COM/i),
      no = fnPins(/^NO/i),
      nc = fnPins(/^NC/i);
    if (coil.length >= 2 && com.length) {
      // a COM may be mirrored across several pins on the same net, so the first is enough
      return { coil: [coil[0], coil[1]], contacts: [{ com: com[0], no: no[0], nc: nc[0] }] };
    }
    return { coil: [], contacts: [] };
  }

  // Coil parameters from the part. Rated voltage from the value/name; coil power from the part where
  // known (HJR-4102 power code N=0.45 / D=0.36 / L=0.2 W, datasheet), else ~0.14 W (G6K class). Pickup
  // ~75 % and release ~10 % of rated match both datasheets and give the latch its hysteresis.
  coil() {
    const s = '' + this.lib + ' ' + this.value;
    const m = s.match(/DC\s*(\d+\.?\d*)|(\d+\.?\d*)\s*V/i);
    const Vr = m ? parseFloat(m[1] || m[2]) : 5;
    const pc = s.match(/HJR-?4102-?([NDL])/i);
    const P = pc ? { N: 0.45, D: 0.36, L: 0.2 }[pc[1].toUpperCase()] : 0.14;
    return { R: (Vr * Vr) / P, pickup: 0.75 * Vr, release: 0.1 * Vr };
  }

  elements() {
    const po = this.pinout();
    const cm = this.coil();
    const N = (p) => this.pins[p];

    const coilA = po.coil && N(po.coil[0]);
    const coilB = po.coil && N(po.coil[1]);

    const els = [];

    if (coilA && coilB) {
      els.push({ type: 'R', a: coilA, b: coilB, value: cm.R, ref: this.ref, pa: po.coil[0], pb: po.coil[1] }); // coil = R load
    }

    for (const ct of po.contacts || []) {
      if (N(ct.com) && N(ct.no)) {
        els.push({ type: 'RC', a: N(ct.com), b: N(ct.no), coilA, coilB, pickup: cm.pickup, release: cm.release, when: 'on', ref: this.ref, pa: ct.com, pb: ct.no });
      }
      if (N(ct.com) && N(ct.nc)) {
        els.push({ type: 'RC', a: N(ct.com), b: N(ct.nc), coilA, coilB, pickup: cm.pickup, release: cm.release, when: 'off', ref: this.ref, pa: ct.com, pb: ct.nc });
      }
    }

    return els;
  }

  // is the coil pulled in, given a voltage(net) reader?
  energized(voltAt) {
    const po = this.pinout();
    if (!po.coil || po.coil.length < 2) return null;

    const va = voltAt(this.pins[po.coil[0]]);
    const vb = voltAt(this.pins[po.coil[1]]);

    if (va == null || vb == null) return null;

    return Math.abs(va - vb) >= this.coil().pickup;
  }
}
