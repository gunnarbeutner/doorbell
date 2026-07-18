import { Component } from './Component.js';

export default class Capacitor extends Component {
  static kind = 'capacitor';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);
    return cat.includes('capacitor') || name === 'c' || name.startsWith('c_') || Component.refPre(c.ref) === 'C';
  }

  elements(ctx) {
    const nominal = this.val();
    if (nominal == null) return [];
    const value = this.param(ctx, 'value', nominal);
    const scale = this.param(ctx, 'valueScale', 1);
    const leakResistance = this.param(ctx, 'leakResistance', null);
    const v = value * scale;
    if (!(v > 0)) throw new RangeError(`${this.ref} capacitance must be positive`);
    if (leakResistance != null && !(leakResistance > 0))
      throw new RangeError(`${this.ref} leakResistance must be positive`);

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

    const els = [e];
    if (leakResistance != null)
      els.push({ type: 'R', a: p[0], b: p[1], value: leakResistance, ref: `${this.ref}~leak`, pa: k[0], pb: k[1] });
    return els;
  }

  // voltage rating (parsed from a "…/50V" value) and, for electrolytics, reverse-polarity.
  checkSafe(vn) {
    const out = [];
    const ks = Object.keys(this.pins);
    if (ks.length !== 2) return out;
    const m = /\/\s*(\d+(?:\.\d+)?)\s*v/i.exec(this.value);
    const rating = m ? +m[1] : null;
    if (/polariz|electrolyt|tantal/i.test(this.lib)) {
      const dv = vn[this.pins['1']] - vn[this.pins['2']]; // pin1 = +, pin2 = −
      this.chk(out, '1-2', `${this.pins['1']}↔${this.pins['2']}`, dv, -0.3, rating ?? Infinity,
        rating ? `electrolytic: reverse-polarity + ${rating} V rating` : 'electrolytic reverse polarity');
    } else if (rating) {
      const dv = vn[this.pins[ks[0]]] - vn[this.pins[ks[1]]];
      if (Number.isFinite(dv)) this.chk(out, `${ks[0]}-${ks[1]}`, `${this.pins[ks[0]]}↔${this.pins[ks[1]]}`, Math.abs(dv), -Infinity, rating, `cap ${rating} V rating`);
    }
    return out;
  }
}
