import { Component, twoTerminal } from './Component.js';

// A ferrite bead is ~0 Ω at DC — a wire for the rail it sits on (FB1: +3V3 -> /AVDD) — and only presents
// impedance at RF, which is irrelevant to these low-frequency board sims. Its printed value (e.g.
// "600R@100MHz") is that HF impedance, NOT a DC resistance, so we deliberately ignore it and model the
// bead as a small fixed resistance (~its DCR): a near-short that keeps the rail connected.
export default class FerriteBead extends Component {
  static kind = 'ferrite';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);
    return (
      cat.includes('ferrite') ||
      name.includes('ferrite') ||
      name.includes('bead') ||
      Component.refPre(c.ref) === 'FB'
    );
  }

  elements() {
    return twoTerminal(this, 'R', 0.1); // ~DCR; a DC short for the rail (ignore the "@MHz" impedance spec)
  }
}
