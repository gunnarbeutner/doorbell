import { Component, twoTerminal } from './Component.js';

export default class Inductor extends Component {
  static kind = 'inductor';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    return (
      cat.includes('inductor') ||
      cat.includes('ferrite') ||
      name === 'l' ||
      name.startsWith('l_') ||
      Component.refPre(c.ref) === 'L'
    );
  }

  elements() {
    return twoTerminal(this, 'L');
  }
}
