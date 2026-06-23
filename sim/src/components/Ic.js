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

  elements() {
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

    return els;
  }
}
