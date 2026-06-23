import { Component } from './Component.js';

// PhotoMOS solid-state relay (AC, bidirectional MOSFET output) — Panasonic AQY/AQW / SUPSiC GAQY/GAQW.
// Single-channel (4-pin): 1 = LED anode, 2 = LED cathode (the optically-isolated control side); 3 & 4 =
// the output drains (the bidirectional switch terminals, no electrical tie to the LED side).
// Dual-channel GAQW212GS (8-pin SOP-8): two independent 1-Form-A switches in one package —
//   ch1 LED 1/2 → contact 7/8 ; ch2 LED 3/4 → contact 5/6 (again no LED↔output tie).
//
//   GAQY212GS — 1-Form-A (normally OPEN): LED energized -> output closed, Ron ~0.24 Ω.
//   GAQY412EH — 1-Form-B (normally CLOSED): LED energized -> output open; closed (Ron ~1 Ω) at rest.
//   GAQW212GS — dual 1-Form-A (normally OPEN): each LED energized -> its own output closed.
//
// The output is modeled as a plain bidirectional resistance (Ron when conducting, ~open otherwise);
// the LED is a diode whose forward current sets the energized state (operate threshold ~3 mA).
export default class Photomos extends Component {
  static kind = 'optocoupler';

  // matched by lib nickname, Value, or footprint (the real parts carry the GAQY/GAQW name in any of these)
  static tag(c) {
    return (Component.lc(c.lib).name + ' ' + (c.value || '') + ' ' + (c.footprint || '')).toLowerCase();
  }

  // dual = the 8-pin GAQW212GS (two channels in a SOP-8); everything else is a 4-pin single channel
  static isDual(c) {
    const tag = Photomos.tag(c);
    return /gaqw|aqw\d/.test(tag) || /sop-8_l[\d.]+-w4\.4-p2\.54/.test(tag);
  }

  static compatible(c) {
    const tag = Photomos.tag(c);
    const P = c.pins || {};
    // GAQY212GS "SOP-4_...", GAQY412EH "SMD-4_...", GAQW212GS "SOP-8_L9.8-W4.4-P2.54-LS6.8-BL"
    const isPhotomos =
      /gaq[yw]|aq[yw]\d|photomos/.test(tag) ||
      /(sop|smd)-4_l[\d.]+-w[\d.]+-p2\.54/.test(tag) ||
      /sop-8_l[\d.]+-w4\.4-p2\.54/.test(tag);
    if (!isPhotomos) return false;
    const has = (...ps) => ps.every((p) => P[String(p)] != null);
    return Photomos.isDual(c) ? has(1, 2, 3, 4, 5, 6, 7, 8) : has(1, 2, 3, 4);
  }

  // form / on-resistance / LED operate threshold by part type (lib nickname, Value, or footprint)
  model() {
    const tag = Photomos.tag(this);

    // GAQW212GS: dual 1-Form-A (normally open). Ron ~0.8 Ω/ch (datasheet typ; max 2 Ω) — immaterial in the
    // talk path vs the 2.2 k series R28 anyway; operate ≤2 mA (each LED is driven at ~7 mA from a 300 Ω R).
    if (Photomos.isDual(this)) return { form: 'NO', ron: 0.8, iop: 3e-3, dual: true };

    // GAQY412EH: 1-Form-B (normally closed), Ron ~1 Ω, operate ~3 mA (footprint SMD-4 ...-W6.4-...-LS9.6)
    if (/gaqy412/.test(tag) || /smd-4_l[\d.]+-w6\.4-p2\.54-ls9\.6/.test(tag)) return { form: 'NC', ron: 1, iop: 3e-3 };

    // GAQY212GS: 1-Form-A (normally open), Ron ~0.24 Ω (datasheet typ), operate ≤2 mA
    return { form: 'NO', ron: 0.24, iop: 3e-3 };
  }

  elements() {
    const P = this.pins;
    const m = this.model();

    // closedWhenOn = does the output conduct when the LED is energized? (NO yes, NC no). LED diode
    // params mirror the optocoupler's IR LED (~1.1 V forward). iop = the LED forward operate current.
    const ch = (a, b, c, d) => ({
      type: 'SSR',
      a: P[a], b: P[b], c: P[c], d: P[d],
      pa: a, pb: b, pc: c, pd: d,
      closedWhenOn: m.form !== 'NC',
      ron: m.ron, iop: m.iop, Is: 1e-13, n: 1.9,
      ref: this.ref,
    });

    if (m.dual) {
      if (![1, 2, 3, 4, 5, 6, 7, 8].every((p) => P[String(p)] != null)) return [];
      // GAQW212GS: ch1 LED 1/2 → contact 7/8 ; ch2 LED 3/4 → contact 5/6
      return [ch('1', '2', '7', '8'), ch('3', '4', '5', '6')];
    }
    if (P['1'] == null || P['2'] == null || P['3'] == null || P['4'] == null) return [];
    return [ch('1', '2', '3', '4')];
  }

  // GAQ-series PhotoMOS abs-max: output contact off-state ±60 V (Voff), LED reverse 5 V (VR).
  checkSafe(vn) {
    const out = [];
    const V = (p) => vn[this.pins[p]];
    const VOFF = 60, VR = 5;
    const groups = Photomos.isDual(this) ? [['1', '2', '7', '8'], ['3', '4', '5', '6']] : [['1', '2', '3', '4']];
    for (const [la, lk, c, d] of groups) {
      this.chk(out, `${c}-${d}`, `${this.pins[c]}↔${this.pins[d]}`, V(c) - V(d), -VOFF, VOFF, `PhotoMOS contact off-state ±${VOFF} V (Voff)`);
      this.chk(out, `${la}-${lk}`, `${this.pins[la]}↔${this.pins[lk]}`, V(la) - V(lk), -VR, Infinity, `PhotoMOS LED reverse ${VR} V (VR)`);
    }
    return out;
  }
}
