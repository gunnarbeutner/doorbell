import { Component } from './Component.js';

export default class Diode extends Component {
  static kind = 'diode';

  static compatible(c) {
    const { cat, name } = Component.lc(c.lib);

    const looksDiode =
      cat.includes('diode') || name === 'd' || name.startsWith('d_') || Component.refPre(c.ref) === 'D';

    return looksDiode && Object.keys(c.pins || {}).length === 2; // a real 2-terminal diode
  }

  // Shockley Is/n by diode family — sets the forward drop. TVS parts also carry a reverse
  // breakdown (vbr) and, for the bidirectional kind, a `bidir` flag (see elements()).
  model() {
    if (/LMBR01S30ST5G/i.test(this.value)) return {
      Is: 1e-6,
      n: 1.05,
      vrr: 30,
      // The electrical solver is nominal. Keep the qualification limit beside the model so tests
      // cannot mistake a nominal waveform for a guaranteed temperature-corner result.
      qualification: {
        vfMax: 0.30,
        vfTestCurrent: 0.010,
        vfSpecifiedTempC: [25, 25],
      },
    };
    if (/1N4004W/i.test(this.value)) return { Is: 1e-14, n: 1, vrr: 400 };
    if (/schottky/i.test(this.lib)) return { Is: 1e-6, n: 1.05, vrr: 40 }; // SS14 — low Vf (~0.3-0.4 V)
    if (/LED/i.test(this.lib)) return { Is: 1e-15, n: 2.6 }; // visible LED — high Vf (~1.8-2 V)
    if (/TVS/i.test(this.lib)) {
      // Bidirectional bus TVS (H24VND3BA): ~24 V standoff / ~31 V breakdown — must stay OPEN
      // across the bus operating + transient range (≤ ±17 V) and clamp only on fault. Modeling it
      // as a plain forward diode pins the bus to ~0.8 V (this is the bug this fixes). The
      // unidirectional TVS (SMF5.0A on VBUS) is oriented as a reverse clamp that never
      // forward-conducts in normal use, so it stays forward-only.
      if (/TVS[-_ ]?Bi|bidir/i.test(this.lib)) return { Is: 1e-12, n: 1, vbr: 31, bidir: true };
      // Unidirectional TVS (SMF5.0A on VBUS): 5 V standoff, ~6.5 V breakdown. Oriented as a reverse clamp,
      // so it stays off in normal use (≤5 V) but breaks down on a +VBUS surge — clamping VBUS_F to ~7-9 V
      // (which then drives a huge current through F1 and blows it: the SAFE-7 fail-safe).
      return { Is: 1e-12, n: 1, vbr: 6.5 };
    }
    return { Is: 1e-14, n: 1 }; // general silicon diode (~0.6-0.7 V)
  }

  elements() {
    if (this.pins['1'] == null || this.pins['2'] == null) return [];

    const m = this.model();
    const a = this.pins['2'],
      b = this.pins['1']; // KiCad Device:D pin 1 = cathode, pin 2 = anode

    if (m.bidir) {
      // Bidirectional TVS = two Zeners in anti-series (common cathode at an internal midpoint).
      // Whichever way the line swings, one half is forward (~0.7 V) and the other is in reverse
      // breakdown (vbr), so the pair conducts only at ~vbr + Vf either way and is open below that.
      const mid = this.ref + '~mid';
      return [
        { type: 'D', a, b: mid, value: null, Is: m.Is, n: m.n, vbr: m.vbr, ref: this.ref + 'a' },
        { type: 'D', a: b, b: mid, value: null, Is: m.Is, n: m.n, vbr: m.vbr, ref: this.ref + 'b' },
      ];
    }

    return [{ type: 'D', a, b, value: null, Is: m.Is, n: m.n, vbr: m.vbr, ref: this.ref }];
  }

  // reverse-voltage abs-max. A TVS is meant to clamp (rate by energy, not Vr) — skip it here.
  checkSafe(vn) {
    if (/TVS/i.test(this.lib)) return [];
    const Vrr = this.model().vrr ?? 75;
    const out = [];
    const vk = vn[this.pins['1']], va = vn[this.pins['2']]; // KiCad Device:D pin1 = cathode, pin2 = anode
    this.chk(out, '1-2', `${this.pins['1']}↔${this.pins['2']}`, vk - va, -Infinity, Vrr, `diode reverse Vrr ${Vrr} V`);
    return out;
  }
}
