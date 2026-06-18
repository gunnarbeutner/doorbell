import { Component } from './Component.js';

export default class Transformer extends Component {
  static kind = 'transformer';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    return (
      cat.includes('sm_lp') ||
      name.includes('sm-lp-5001') ||
      name.includes('transformer') ||
      Component.refPre(c.ref) === 'T'
    );
  }

  model() {
    // SM-LP-5001 line transformer: Rdc 115 Ω (datasheet); L set so wL ~ 600 Ω at 300 Hz
    if (/SM-LP-5001/i.test(this.lib)) return { L: 0.32, k: 0.97, Rdc: 115 };

    return { L: 0.05, k: 0.95, Rdc: 0 };
  }

  // two coupled inductors; windings = first / second half of the connected pins
  elements() {
    const P = this.pins;

    const cp = Object.keys(P)
      .filter((k) => P[k] && !/^unconnected/.test(P[k]))
      .sort((x, y) => +x - +y);

    if (cp.length < 4) return [];

    const m = this.model();
    const h = Math.ceil(cp.length / 2);
    const M = m.k * m.L;

    const primary = { type: 'L', a: P[cp[0]], b: P[cp[h - 1]], value: m.L, dcr: m.Rdc, ref: this.ref + '~p' };
    const secondary = { type: 'L', a: P[cp[h]], b: P[cp[cp.length - 1]], value: m.L, dcr: m.Rdc, ref: this.ref + '~s' };

    primary.coupL = secondary;
    secondary.coupL = primary;
    primary.M = M;
    secondary.M = M;

    return [primary, secondary];
  }
}
