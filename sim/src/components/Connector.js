import { Component } from './Component.js';

// An external connection point: recognized (ok) but contributes no electrical model.
export default class Connector extends Component {
  static kind = 'connector';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    return (
      name.includes('usb_c') ||
      name.startsWith('conn_') ||
      cat.includes('connector') ||
      ['J', 'P'].includes(Component.refPre(c.ref))
    );
  }
}
