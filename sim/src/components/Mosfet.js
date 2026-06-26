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
    // 2N7002 (CJ, docs/2n7002_datasheet.pdf): Vgs(th) typ 1.6 V (1.0-2.5 V); Rds(on) ~5 Ω at Vgs = 10 V
    if (/2N7002/i.test(this.lib)) return { vth: 1.6, ron: 5 };

    return { vth: 2, ron: 1 };
  }

  elements() {
    // One MOS per FET. A single FET exposes G/D/S; a dual (e.g. 2N7002DW) exposes G1/D1/S1 +
    // G2/D2/S2 — group the pins by the unit index trailing the role letter and emit a MOS for each,
    // so both halves are modelled instead of one franken-FET mixed from byFn across the units.
    const fets = {};
    for (const p in this.pinfn) {
      const mm = /^([GDS])(\d*)/.exec(this.pinfn[p]);
      if (!mm) continue;
      (fets[mm[2] || '0'] ??= {})[mm[1].toLowerCase()] = this.pins[p];
    }

    const m = this.model();
    const keys = Object.keys(fets);

    // Keep ref = the footprint refdes for every FET (no per-unit suffix): MOS is stateless, so the
    // engine never keys state on it, and the trace-flow view matches pad currents to the footprint
    // by exact ref — a "Q3:2" would map to no pad and drop the dual's currents from the PCB view.
    return keys.flatMap((k) => {
      const { g, d, s } = fets[k];
      if (g == null || d == null || s == null) return [];
      return [{ type: 'MOS', g, d, s, vth: m.vth, ron: m.ron, ref: this.ref }];
    });
  }
}
