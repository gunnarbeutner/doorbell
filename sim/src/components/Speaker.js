import { Component, twoTerminal } from './Component.js';

export default class Speaker extends Component {
  static kind = 'speaker';

  static compatible(c) {
    const { name } = Component.lc(c.lib);

    return name.includes('speaker') || ['LS', 'SP'].includes(Component.refPre(c.ref));
  }

  elements() {
    return twoTerminal(this, 'R'); // rated impedance as R
  }
}
