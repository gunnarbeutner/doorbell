import { Component } from './Component.js';
import { netV } from '../engine.js';

// Supply-current model for the big ICs. Their *function* (GPIO, I2S, USB, codec) is not simulated — they
// stay flagged unmodeled (red), so signals through their pins aren't trusted — but their power draw is:
// each becomes an equivalent resistive load from its supply pin to GND, sized for a representative active
// current. That pulls the draw through the LDO -> +5V -> Schottky -> VBUS, so the regulator chain loads
// down realistically and the current shows in the trace-flow animation.
//
// The one analog exception is the ES8311 VMID reference (see elements()): the external mic front-end
// (R30-R33 divider/bias, C12) is biased to it, so it must be anchored for the audio path to have a DC
// operating point. The digital codec function (I2S, DAC/ADC, registers, gain) stays unmodeled.
//
// Representative active-mode currents (adjust here for a different operating point):
//   ESP32-S3-MINI-1  ~100 mA  dual-core 240 MHz, Wi-Fi connected/listening (TX bursts run much higher)
//   ES8311 codec     ~10 mA  playback DAC + record ADC active
const LOADS = [
  { re: /esp32/i, mA: 100 },
  { re: /es8311/i, mA: 10 },
];

const VMID_LEG = 1e3; // ES8311 VMID reference: AVDD->VMID->AGND divider leg (see elements()). Low-Z
// to mirror the codec's buffered reference and to settle VMID well within an audio-length run (vs C12).

export default class Ic extends Component {
  static kind = 'ic';

  static compatible(c) {
    return LOADS.some((l) => l.re.test(c.lib || ''));
  }

  get modeled() {
    return false; // only the supply current is modeled, not the I/O — keep the "signals not simulated" flag
  }

  elements(ctx) {
    const spec = LOADS.find((l) => l.re.test(this.lib));
    if (!spec) return [];

    const pinByFn = (re) => {
      for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p;
      return null;
    };
    const els = [];

    // supply pin (3V3 / *VDD) and a ground pin, by function -> equivalent active-current load
    const vp = pinByFn(/3V3|VDD/),
      gp = pinByFn(/GND/);
    if (vp != null && gp != null) {
      const vdd = this.pins[vp],
        gnd = this.pins[gp];
      if (vdd && gnd && vdd !== gnd) {
        const R = (netV(vdd) || 3.3) / (spec.mA / 1000); // equivalent load resistance at the nominal rail
        els.push({ type: 'R', a: vdd, b: gnd, value: R, ref: this.ref, pa: vp, pb: gp });
      }
    }

    // ES8311 VMID reference (the one analog node the board depends on). The codec internally buffers
    // VMID to ~AVDD/2; the mic front-end biases MIC1P/N to it through R32/R33 (C12 decouples it).
    // Model it as an AVDD->VMID->AGND divider: it anchors VMID at AVDD/2, tracks the rail (collapses if
    // AVDD is lost), and is AC-grounded by C12. High-value legs draw ~µA — negligible load on AVDD, and
    // no DC error on the bias network since the 3.3k shunts carry no DC current (the series caps block it).
    if (/es8311/i.test(this.lib)) {
      const ap = pinByFn(/AVDD/),
        mp = pinByFn(/VMID/),
        agp = pinByFn(/AGND/);
      if (ap != null && mp != null && agp != null) {
        const avdd = this.pins[ap],
          vmid = this.pins[mp],
          agnd = this.pins[agp];
        if (avdd && vmid && agnd && avdd !== vmid && vmid !== agnd) {
          els.push({ type: 'R', a: avdd, b: vmid, value: VMID_LEG, ref: this.ref, pa: ap, pb: mp });
          els.push({ type: 'R', a: vmid, b: agnd, value: VMID_LEG, ref: this.ref, pa: mp, pb: agp });
        }
      }
    }

    // --- programmable behavioural drivers (so a testbench injects only VBUS/GND/bus) ---
    // A test sets ctx.program[ref] to drive this IC's outputs from INSIDE the model: the codec DAC and the
    // ESP GPIOs are emitted here as a source behind the part's real output impedance (+ the codec's on-chip
    // ESD clamps), so OUTP / the GPIO nets EMERGE rather than being pinned by an ideal source on an
    // internal node. Each driver is a V-source + a bleed R (so reachFrom anchors the core node).
    const prog = ctx && ctx.program && ctx.program[this.ref];
    if (prog) {
      const ROUT = 40, RGPIO = 30, BLEED = 1e5;
      const asVf = (x) => (typeof x === 'function' ? x : () => x);

      if (/es8311/i.test(this.lib) && prog.out != null) {
        const ag = this.pins[pinByFn(/AGND/)] || this.pins[pinByFn(/GND/)];
        const av = this.pins[pinByFn(/AVDD/)];
        const o = prog.out; // scalar/vf -> both legs; { p, n } -> per-leg
        const driveOut = (tag, pin, vf) => {
          if (!pin || !ag) return;
          const core = `${this.ref}~${tag}`;
          els.push({ type: 'V', a: core, b: ag, vf, ref: `${this.ref}~${tag}_v` });
          els.push({ type: 'R', a: core, b: ag, value: BLEED, ref: `${this.ref}~${tag}_bl` });
          els.push({ type: 'R', a: core, b: pin, value: ROUT, ref: `${this.ref}~${tag}_r` });
          if (av) els.push({ type: 'D', a: pin, b: av, Is: 1e-14, n: 1, ref: `${this.ref}~${tag}_ch` }); // ESD clamp -> AVDD
          els.push({ type: 'D', a: ag, b: pin, Is: 1e-14, n: 1, ref: `${this.ref}~${tag}_cl` }); // ESD clamp -> AGND
        };
        driveOut('outp', this.pins[pinByFn(/OUTP/)], asVf(o && o.p != null ? o.p : o));
        driveOut('outn', this.pins[pinByFn(/OUTN/)], asVf(o && o.n != null ? o.n : o));
      }

      if (/esp32/i.test(this.lib)) {
        const g = this.pins[pinByFn(/^GND/)];
        for (const net in prog) {
          if (net[0] !== '/') continue; // a GPIO net to drive (e.g. '/PTT_DRV')
          let pin = null;
          for (const p in this.pins) if (this.pins[p] === net && /GPIO\d/.test(this.pinfn[p] || '')) pin = p;
          if (!pin || !g) continue;
          const core = `${this.ref}~g${pin}`;
          els.push({ type: 'V', a: core, b: g, vf: asVf(prog[net]), ref: `${this.ref}~g${pin}_v` });
          els.push({ type: 'R', a: core, b: g, value: BLEED, ref: `${this.ref}~g${pin}_bl` });
          els.push({ type: 'R', a: core, b: this.pins[pin], value: RGPIO, ref: `${this.ref}~g${pin}_r` });
        }
      }
    }

    return els;
  }

  // Absolute-maximum windows expressed against this IC's OWN supply/ground pins.
  checkSafe(vn) {
    const out = [];
    const V = (p) => (p == null ? undefined : vn[this.pins[p]]);
    const fnPin = (re) => { for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p; return null; };

    if (/es8311/i.test(this.lib)) {
      const agnd = Number.isFinite(V(fnPin(/AGND/))) ? V(fnPin(/AGND/)) : 0;
      const avdd = V(fnPin(/AVDD/));
      // only judge the analog pins once the codec is actually powered — an unsettled/absent AVDD makes the
      // [AGND-0.3, AVDD+0.3] window meaningless (and would false-flag during cold-start rail settling).
      if (Number.isFinite(avdd) && avdd >= 2)
        for (const p in this.pinfn)
          if (/OUTP|OUTN|VMID|MIC1|DACVREF|ADCVREF/.test(this.pinfn[p]))
            this.chk(out, this.pinfn[p], this.pins[p], V(p), agnd - 0.3, avdd + 0.3,
              `ES8311 analog abs-max [AGND-0.3, AVDD+0.3] ≈ [${(agnd - 0.3).toFixed(2)}, ${(avdd + 0.3).toFixed(2)}] V`);
      for (const p in this.pinfn)
        if (/PVDD|DVDD|AVDD/.test(this.pinfn[p]))
          this.chk(out, this.pinfn[p], this.pins[p], V(p), -0.3, 3.6, 'ES8311 supply abs-max 3.6 V');
    } else if (/esp32/i.test(this.lib)) {
      const gnd = Number.isFinite(V(fnPin(/^GND/))) ? V(fnPin(/^GND/)) : 0;
      const vddP = fnPin(/3V3|VDD/), vdd = V(vddP);
      if (Number.isFinite(vdd) && vdd >= 2) // only judge GPIOs once the MCU rail is up (see ES8311 note)
        for (const p in this.pinfn)
          if (/GPIO\d/.test(this.pinfn[p]))
            this.chk(out, this.pinfn[p], this.pins[p], V(p), gnd - 0.3, vdd + 0.3,
              `ESP GPIO abs-max [VSS-0.3, VDD+0.3] ≈ [${(gnd - 0.3).toFixed(2)}, ${(vdd + 0.3).toFixed(2)}] V`);
      if (vddP) this.chk(out, this.pinfn[vddP], this.pins[vddP], vdd, -0.3, 3.6, 'ESP VDD33 abs-max 3.6 V');
    }
    return out;
  }

  // UI: click the footprint to drive this IC. ESP → toggle each actuator GPIO (the *_DRV nets) high/low;
  // ES8311 → set the DAC output (off / mid-rail bias / a 1 kHz tone). buildElements turns these into the
  // behavioural drivers above (ctx.program[ref]).
  programSchema() {
    if (/esp32/i.test(this.lib)) {
      const gpios = [];
      for (const p in this.pinfn)
        if (/GPIO\d/.test(this.pinfn[p]) && /DRV/.test(this.pins[p] || ''))
          gpios.push({ net: this.pins[p], label: this.pinfn[p].replace(/_\d+$/, '') });
      return gpios.length ? { kind: 'esp', ref: this.ref, gpios, high: 3.3 } : null;
    }
    if (/es8311/i.test(this.lib)) return { kind: 'codec', ref: this.ref };
    return null;
  }
}
