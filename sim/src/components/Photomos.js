import { Component } from './Component.js';

// PhotoMOS solid-state relay (AC, bidirectional MOSFET output) — Panasonic AQY/GAQY family.
// Pins 1 = LED anode, 2 = LED cathode (the optically-isolated control side); 3 & 4 = the output
// drains (the bidirectional switch terminals, no electrical tie to the LED side).
//
//   GAQY212GS — 1-Form-A (normally OPEN): LED energized -> output closed, Ron ~0.24 Ω.
//   GAQY412EH — 1-Form-B (normally CLOSED): LED energized -> output open; closed (Ron ~1 Ω) at rest.
//
// The output is modeled as a plain bidirectional resistance (Ron when conducting, ~open otherwise);
// the LED is a diode whose forward current sets the energized state (operate threshold ~3 mA).
export default class Photomos extends Component {
  static kind = 'optocoupler';

  // matched by lib nickname, Value, or footprint (the real parts carry the GAQY name in any of these)
  static tag(c) {
    return (Component.lc(c.lib).name + ' ' + (c.value || '') + ' ' + (c.footprint || '')).toLowerCase();
  }

  static compatible(c) {
    const tag = Photomos.tag(c);
    const P = c.pins || {};
    // GAQY212GS footprint "SOP-4_L4.3-W4.4-P2.54-LS6.8-TR" / GAQY412EH "SMD-4_L4.8-W6.4-P2.54-LS9.6-BL"
    const isPhotomos = /gaqy|aqy\d|photomos/.test(tag) || /(sop|smd)-4_l[\d.]+-w[\d.]+-p2\.54/.test(tag);

    return isPhotomos && P['1'] != null && P['2'] != null && P['3'] != null && P['4'] != null;
  }

  // form / on-resistance / LED operate threshold by part type (lib nickname, Value, or footprint)
  model() {
    const tag = Photomos.tag(this);

    // GAQY412EH: 1-Form-B (normally closed), Ron ~1 Ω, operate ~3 mA (footprint SMD-4 ...-W6.4-...-LS9.6)
    if (/gaqy412/.test(tag) || /smd-4_l[\d.]+-w6\.4-p2\.54-ls9\.6/.test(tag)) return { form: 'NC', ron: 1, iop: 3e-3 };

    // GAQY212GS: 1-Form-A (normally open), Ron ~0.24 Ω, operate ~3 mA
    return { form: 'NO', ron: 0.24, iop: 3e-3 };
  }

  elements() {
    const P = this.pins;
    if (P['1'] == null || P['2'] == null || P['3'] == null || P['4'] == null) return [];

    const m = this.model();

    // closedWhenOn = does the output conduct when the LED is energized? (NO yes, NC no). LED diode
    // params mirror the optocoupler's IR LED (~1.1 V forward). iop = the LED forward operate current.
    return [
      {
        type: 'SSR',
        a: P['1'], b: P['2'], c: P['3'], d: P['4'],
        pa: '1', pb: '2', pc: '3', pd: '4',
        closedWhenOn: m.form !== 'NC',
        ron: m.ron, iop: m.iop, Is: 1e-13, n: 1.9,
        ref: this.ref,
      },
    ];
  }
}
