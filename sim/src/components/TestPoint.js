import { Component } from './Component.js';

// A probe point: recognized (ok) but no electrical model.
export default class TestPoint extends Component {
  static kind = 'testpoint';

  static compatible(c) {
    const { name } = Component.lc(c.lib);

    return name.includes('testpoint') || Component.refPre(c.ref) === 'TP';
  }
}
