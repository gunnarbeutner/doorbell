import { Component } from './Component.js';

export default class Diode extends Component {
  static kind = 'diode';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    const looksDiode =
      cat.includes('diode') || name === 'd' || name.startsWith('d_') || Component.refPre(c.ref) === 'D';

    return looksDiode && Object.keys(c.pins || {}).length === 2; // a real 2-terminal diode
  }

  // Shockley Is/n by diode family — sets the forward drop
  model() {
    if (/schottky/i.test(this.lib)) return { Is: 1e-6, n: 1.05 }; // SS14 — low Vf (~0.3-0.4 V)
    if (/LED/i.test(this.lib)) return { Is: 1e-15, n: 2.6 }; // visible LED — high Vf (~1.8-2 V)
    if (/TVS/i.test(this.lib)) return { Is: 1e-12, n: 1 }; // forward only
    return { Is: 1e-14, n: 1 }; // 1N4148 silicon (~0.6-0.7 V)
  }

  elements() {
    if (this.pins['1'] == null || this.pins['2'] == null) return [];

    const m = this.model();

    // KiCad Device:D pin 1 = cathode, pin 2 = anode
    return [{ type: 'D', a: this.pins['2'], b: this.pins['1'], value: null, Is: m.Is, n: m.n, ref: this.ref }];
  }
}
