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

  elements() {
    return twoTerminal(this, 'R');
  }
}
