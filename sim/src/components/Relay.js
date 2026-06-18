import { Component } from './Component.js';

export default class Relay extends Component {
  static kind = 'relay';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);
    return cat.includes('relay') || name.includes('g6k');
  }

  get role() {
    return 'relay'; // coil-driven, read-only in the panel
  }

  // Omron G6K-2F DPDT
  pinout() {
    return {
      coil: [1, 8],
      contacts: [
        { com: 3, nc: 2, no: 4 },
        { com: 6, nc: 7, no: 5 },
      ],
    };
  }

  // coil R and pull-in from the rated coil voltage in the value string (G6K ~140 mW; pull-in ~75 %)
  coil() {
    const m = ('' + this.value).match(/DC\s*(\d+\.?\d*)|(\d+\.?\d*)\s*V/i);
    const Vr = m ? parseFloat(m[1] || m[2]) : 5;
    return { R: (Vr * Vr) / 0.14, pullin: 0.75 * Vr };
  }

  elements() {
    const po = this.pinout();
    const cm = this.coil();
    const N = (p) => this.pins[p];

    const coilA = po.coil && N(po.coil[0]);
    const coilB = po.coil && N(po.coil[1]);

    const els = [];

    if (coilA && coilB) {
      els.push({ type: 'R', a: coilA, b: coilB, value: cm.R, ref: this.ref }); // coil = R load
    }

    for (const ct of po.contacts || []) {
      if (N(ct.com) && N(ct.no)) {
        els.push({ type: 'RC', a: N(ct.com), b: N(ct.no), coilA, coilB, pullin: cm.pullin, when: 'on', ref: this.ref });
      }
      if (N(ct.com) && N(ct.nc)) {
        els.push({ type: 'RC', a: N(ct.com), b: N(ct.nc), coilA, coilB, pullin: cm.pullin, when: 'off', ref: this.ref });
      }
    }

    return els;
  }

  // is the coil pulled in, given a voltage(net) reader?
  energized(voltAt) {
    const po = this.pinout();
    const va = voltAt(this.pins[po.coil[0]]);
    const vb = voltAt(this.pins[po.coil[1]]);

    if (va == null || vb == null) return null;

    return Math.abs(va - vb) >= this.coil().pullin;
  }
}
