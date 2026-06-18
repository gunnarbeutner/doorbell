import { Component } from './Component.js';

export default class Capacitor extends Component {
  static kind = 'capacitor';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);
    return cat.includes('capacitor') || name === 'c' || name.startsWith('c_') || Component.refPre(c.ref) === 'C';
  }

  elements() {
    const v = this.val();
    if (v == null) return [];

    const p = this.connectedPins();
    if (p.length !== 2) return [];

    const k = Object.keys(this.pins); // pin numbers (for per-pad currents)
    const e = { type: 'C', a: p[0], b: p[1], value: v, ref: this.ref, pa: k[0], pb: k[1] };

    // electrolytic / tantalum: flag the polarity so a reverse bias can be reported (KiCad pin 1 = +)
    if (/polariz|electrolyt|tantal/i.test(this.lib)) {
      e.polar = true;
      e.plus = this.pins['1'];
      e.minus = this.pins['2'];
    }

    return [e];
  }
}
