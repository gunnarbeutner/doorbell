import { Component } from './Component.js';

// A transistor used as a gate-controlled switch (NMOS-style), identified by its part type *and*
// its G/D/S pin functions — so a USB connector with GND/D+/SHIELD pins isn't mistaken for a FET.
export default class Mosfet extends Component {
  static kind = 'mosfet';

  static compatible(c) {
    if (!Mosfet.isTransistorPart(c)) return false;

    const [g, d, s] = Mosfet.gateDrainSource(c.pinfn || {});
    return g && d && s;
  }

  static isTransistorPart(c) {
    const { cat, name } = Component.lc(c.lib);

    if (cat.includes('transistor')) return true;
    if (/mosfet|nmos|pmos|2n7002|bjt/.test(name)) return true;

    return ['Q', 'M'].includes(Component.refPre(c.ref));
  }

  // whether the symbol exposes gate / drain / source pin functions
  static gateDrainSource(fn) {
    let g = false;
    let d = false;
    let s = false;

    for (const p in fn) {
      if (/^G/.test(fn[p])) g = true;
      if (/^D/.test(fn[p])) d = true;
      if (/^S/.test(fn[p])) s = true;
    }

    return [g, d, s];
  }

  model() {
    // 2N7002: Vgs(th) ~2.1 V, Rds(on) ~5 Ω at Vgs = 4.5 V
    if (/2N7002/i.test(this.lib)) return { vth: 2.1, ron: 5 };

    return { vth: 2, ron: 1 };
  }

  elements() {
    const g = this.byFn(/^G/);
    const d = this.byFn(/^D/);
    const s = this.byFn(/^S/);

    if (g == null || d == null || s == null) return [];

    const m = this.model();

    return [{ type: 'MOS', g, d, s, vth: m.vth, ron: m.ron, ref: this.ref }];
  }
}
