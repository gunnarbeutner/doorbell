import { Component, twoTerminal } from './Component.js';

export default class Resistor extends Component {
  static kind = 'resistor';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    return (
      cat.includes('resistor') ||
      name === 'r' ||
      name.startsWith('r_') ||
      Component.refPre(c.ref) === 'R' // refdes fallback (registry order means specific parts match first)
    );
  }

  elements(ctx) {
    const nominal = this.val();
    if (nominal == null) return [];
    const value = this.param(ctx, 'value', nominal);
    const scale = this.param(ctx, 'valueScale', 1);
    if (!(value > 0) || !(scale > 0)) throw new RangeError(`${this.ref} resistance must be positive`);
    return twoTerminal(this, 'R', value * scale);
  }
}
