import { Component } from './Component.js';

export default class EsdArray extends Component {
  static kind = 'protection';

  static compatible(c) {
    const { name } = Component.lc(c.lib);
    return name.includes('tpd2s') || name.includes('esd');
  }

  // group the pins into channels by their CH<n>_IN / CH<n>_OUT functions
  channels() {
    const ch = {};

    for (const p in this.pinfn) {
      const m = this.pinfn[p].match(/CH(\d+)_(IN|OUT)/i);
      if (m) (ch[m[1]] = ch[m[1]] || {})[m[2].toUpperCase()] = this.pins[p];
    }

    return Object.keys(ch)
      .filter((k) => ch[k].IN && ch[k].OUT)
      .map((k) => ch[k]);
  }

  // each channel passes IN<->OUT; steering diodes clamp the line to VCC/GND; a ~6 V rail clamp shunts surge
  elements() {
    const vcc = this.byFn(/^VCC|^VDD/i);
    const gnd = this.byFn(/^GND|^VSS/i);
    const chans = this.channels();
    const els = [];

    chans.forEach((io, i) => {
      els.push({ type: 'R', a: io.IN, b: io.OUT, value: 1e-3, ref: this.ref + '~ch' + i }); // pass-through

      if (vcc) els.push({ type: 'D', a: io.IN, b: vcc, value: null, Is: 1e-12, n: 1, ref: this.ref + '~ch' + i + 'h' });
      if (gnd) els.push({ type: 'D', a: gnd, b: io.IN, value: null, Is: 1e-12, n: 1, ref: this.ref + '~ch' + i + 'l' });
    });

    if (chans.length && vcc && gnd) {
      els.push({ type: 'D', a: gnd, b: vcc, value: null, Is: 1e-12, n: 1, vbr: 6, ref: this.ref + '~rail' });
    }

    return els;
  }
}
