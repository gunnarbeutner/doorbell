import { Component } from './Component.js';

// Series dual-diode array (e.g. BAT54SW): two diodes sharing a common pin —
//   A(1) ─▶├─ COM(3) ─▶├─ K(2)
// Used here as a rail clamp on a signal: COM is the protected node, A ties to the low rail
// and K to the high rail, so the pair holds COM within [V(A)−Vf, V(K)+Vf]. The plain Diode
// model only handles 2-terminal parts, so the 3-pin array gets its own class (placed before
// Diode in the registry).
export default class DiodeArray extends Component {
  static kind = 'diode';

  static compatible(c) {
    const { cat } = Component.lc(c.lib);
    const looksDiode = cat.includes('diode') || Component.refPre(c.ref) === 'D';
    const pins = Object.keys(c.pins || {});
    const hasCom = Object.values(c.pinfn || {}).some((f) => /COM/i.test(f || ''));
    return looksDiode && pins.length === 3 && hasCom; // series dual-diode array (A / K / COM)
  }

  // Shockley Is/n by family — sets the forward drop. BAT54SW = Schottky (~0.3 V); a silicon
  // series array (BAV99) would drop ~0.7 V.
  model() {
    return /BAT54|schottky/i.test(`${this.lib} ${this.value}`)
      ? { Is: 1e-6, n: 1.05 } // Schottky, low Vf
      : { Is: 1e-14, n: 1 }; // silicon
  }

  elements(ctx) {
    const A = this.byFn(/^A/i) || this.pins['1']; // anode   -> low rail
    const K = this.byFn(/^K/i) || this.pins['2']; // cathode -> high rail
    const COM = this.byFn(/COM/i) || this.pins['3']; // shared midpoint = protected node
    if (A == null || K == null || COM == null) return [];

    const nominal = this.model();
    const m = {
      Is: this.param(ctx, 'Is', nominal.Is),
      n: this.param(ctx, 'n', nominal.n),
    };
    return [
      { type: 'D', a: A, b: COM, value: null, Is: m.Is, n: m.n, ref: this.ref + 'a' }, // A  ─▶├ COM
      { type: 'D', a: COM, b: K, value: null, Is: m.Is, n: m.n, ref: this.ref + 'b' }, // COM ─▶├ K
    ];
  }
}
