import { Component } from './Component.js';

// Littelfuse 0466001.NRHF: nominal cold resistance 75 mΩ, nominal melting I²t 0.0423 A²s
// (docs/datasheets/littelfuse_0466_datasheet.pdf, electrical-characteristics table).
const FUSE_RON = 0.075;
const FUSE_I2T = 0.0423;

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

  // A behavioural fuse: its fitted cold resistance integrates over-rating current (melting I²t) and latches OPEN
  // once it melts — the SAFE-7 fail-safe. The engine carries the melt/blown state across steps (type 'FUSE').
  elements(ctx) {
    const p = this.connectedPins();
    if (p.length !== 2) return [];

    const k = Object.keys(this.pins);
    const ron = this.param(ctx, 'ron', FUSE_RON);
    const irate = this.param(ctx, 'irate', this.rating());
    const i2t = this.param(ctx, 'i2t', FUSE_I2T);
    return [
      { type: 'FUSE', a: p[0], b: p[1], ron, irate, i2t, melt: 0, blown: false, ref: this.ref, pa: k[0], pb: k[1] },
    ];
  }

  // an intact fuse has 75 mΩ nominal cold resistance; a large drop means it has melted open.
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
