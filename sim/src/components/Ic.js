import { Component } from './Component.js';
import { netV } from '../engine.js';

// Supply-current model for the big ICs. Their *function* (GPIO, I2S, USB, codec) is not simulated — they
// stay flagged unmodeled (red), so signals through their pins aren't trusted — but their power draw is:
// each becomes an equivalent resistive load from its supply pin to GND, sized for a representative active
// current. That pulls the draw through the LDO -> +5V -> Schottky -> VBUS, so the regulator chain loads
// down realistically and the current shows in the trace-flow animation.
//
// Representative active-mode currents (adjust here for a different operating point):
//   ESP32-S3-MINI-1  ~100 mA  dual-core 240 MHz, Wi-Fi connected/listening (TX bursts run much higher)
//   ES8311 codec     ~10 mA  playback DAC + record ADC active
const LOADS = [
  { re: /esp32/i, mA: 100 },
  { re: /es8311/i, mA: 10 },
];

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

    // supply pin (3V3 / *VDD) and a ground pin, by function
    const pinByFn = (re) => {
      for (const p in this.pinfn) if (re.test(this.pinfn[p])) return p;
      return null;
    };
    const vp = pinByFn(/3V3|VDD/);
    const gp = pinByFn(/GND/);
    if (vp == null || gp == null) return [];

    const vdd = this.pins[vp],
      gnd = this.pins[gp];
    if (!vdd || !gnd || vdd === gnd) return [];

    const R = (netV(vdd) || 3.3) / (spec.mA / 1000); // equivalent load resistance at the nominal rail
    return [{ type: 'R', a: vdd, b: gnd, value: R, ref: this.ref, pa: vp, pb: gp }];
  }
}
