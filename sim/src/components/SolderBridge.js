import { Component } from './Component.js';

export default class SolderBridge extends Component {
  static kind = 'connector';

  static compatible(c) {
    return /SolderJumper|Jumper/i.test(c.lib || '');
  }

  get role() {
    return 'bridge';
  }

  get defaultClosed() {
    return true; // bridges are connected by default
  }

  elements(ctx = {}) {
    const pk = Object.keys(this.pins);
    if (pk.length < 2) return [];

    const state = (ctx.switchState || {})[this.ref];
    const closed = state === undefined ? true : !!state;

    return [{ type: 'SW', a: this.pins[pk[0]], b: this.pins[pk[1]], closed, ref: this.ref, pa: pk[0], pb: pk[1] }];
  }
}
