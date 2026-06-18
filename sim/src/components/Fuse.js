import { Component, twoTerminal } from './Component.js';

export default class Fuse extends Component {
  static kind = 'fuse';

  static compatible(c) {
    const { name } = Component.lc(c.lib);

    return name.includes('fuse') || Component.refPre(c.ref) === 'F';
  }

  elements() {
    return twoTerminal(this, 'R', 1e-3); // modeled as a short
  }
}
