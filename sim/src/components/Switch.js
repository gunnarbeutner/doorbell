import { Component } from './Component.js';

export default class Switch extends Component {
  static kind = 'switch';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    return (
      cat.includes('sppj') ||
      name.includes('sppj') ||
      name.includes('tactile') ||
      name.includes('button') ||
      ['S', 'SW'].includes(Component.refPre(c.ref))
    );
  }

  get role() {
    return 'switch'; // a physical button, toggled manually
  }

  pinout() {
    if (/SPPJ322300/.test(this.lib)) {
      return {
        contacts: [
          { com: 2, nc: 3, no: 1 },
          { com: 5, nc: 6, no: 4 },
        ],
      };
    }
    if (/SW_Slide_DPDT|SW_DPDT/i.test(this.lib)) {
      // DPDT slide: groups 1-3 and 4-6; COM = 2/5, NC = 1/6, NO = 3/4
      return {
        contacts: [
          { com: 2, nc: 1, no: 3 },
          { com: 5, nc: 6, no: 4 },
        ],
      };
    }
    if (/Tactile/.test(this.lib) || Object.keys(this.pins).length <= 2) {
      return { spst: [1, 2] };
    }
    return null;
  }

  elements(ctx = {}) {
    const po = this.pinout();
    if (!po) return [];

    const N = (p) => this.pins[p];
    const pressed = !!(ctx.switchState || {})[this.ref];
    const els = [];

    if (po.spst && N(po.spst[0]) && N(po.spst[1])) {
      els.push({ type: 'SW', a: N(po.spst[0]), b: N(po.spst[1]), closed: pressed, ref: this.ref });
    }

    for (const ct of po.contacts || []) {
      if (N(ct.com) && N(ct.no)) els.push({ type: 'SW', a: N(ct.com), b: N(ct.no), closed: pressed, ref: this.ref });
      if (N(ct.com) && N(ct.nc)) els.push({ type: 'SW', a: N(ct.com), b: N(ct.nc), closed: !pressed, ref: this.ref });
    }

    return els;
  }
}
