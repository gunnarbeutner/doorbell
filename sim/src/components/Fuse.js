import { Component } from './Component.js';

const FUSE_RON = 1e-3; // intact: a milliohm
const FUSE_I2T = 0.3; // melting I²t (A²·s of over-rating current) at which it opens — a representative fast fuse

export default class Fuse extends Component {
  static kind = 'fuse';

  static compatible(c) {
    const { name } = Component.lc(c.lib);

    return name.includes('fuse') || Component.refPre(c.ref) === 'F';
  }

  rating() {
    const m = /([\d.]+)\s*A/i.exec(this.value || '');
    return m ? +m[1] : 1; // "1A fast (466)" -> 1 A
  }

  // A behavioural fuse: a near-short that integrates over-rating current (melting I²t) and latches OPEN
  // once it melts — the SAFE-7 fail-safe. The engine carries the melt/blown state across steps (type 'FUSE').
  elements() {
    const p = this.connectedPins();
    if (p.length !== 2) return [];

    const k = Object.keys(this.pins);
    return [
      { type: 'FUSE', a: p[0], b: p[1], ron: FUSE_RON, irate: this.rating(), i2t: FUSE_I2T, melt: 0, blown: false, ref: this.ref, pa: k[0], pb: k[1] },
    ];
  }

  // an intact fuse drops ~0 V (≈1 mΩ); a large drop ⇒ it has melted open (a fault drove it past its rating).
  checkSafe(vn) {
    const out = [];
    const k = Object.keys(this.pins);
    if (k.length !== 2) return out;

    this.chk(
      out,
      `${k[0]}-${k[1]}`,
      `${this.pins[k[0]]}↔${this.pins[k[1]]}`,
      Math.abs(vn[this.pins[k[0]]] - vn[this.pins[k[1]]]),
      -Infinity,
      0.5,
      `fuse blown/open — current exceeded its ${this.rating()} A rating (SAFE-7 fail-safe disconnect)`,
    );
    return out;
  }
}
