// Deterministic qualification corners for the fitted V4.2 parts.
//
// Values labelled `guaranteed` come from the local fitted-part datasheets. MLCC capacitance under
// combined DC bias, temperature and ageing is not guaranteed by Samsung's public graph data, so the
// explicit `engineeringBound` below is an auditable design assumption rather than a datasheet limit.
import { diodeIsAt } from './parameters.js';

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

export const PART_LIMITS = freeze({
  ao3400a: {
    source: 'docs/datasheets/ao3400a_datasheet.pdf p.2',
    vgsThreshold: { min: 0.65, typ: 1.05, max: 1.45, unit: 'V', guaranteed: true },
    gateLeakage: { min: -100e-9, max: 100e-9, unit: 'A', atVgs: 12, guaranteed: true },
    ronMaxAt2V5: { value: 0.048, unit: 'ohm', guaranteed: true },
  },
  gaqy412eh: {
    source: 'docs/datasheets/GAQY412E_EH_datasheet.pdf p.2',
    operateCurrentMax: { value: 3e-3, unit: 'A', guaranteed: true },
    recoveryCurrentMin: { value: 0.1e-3, unit: 'A', guaranteed: true },
    recoveryVoltageMin: { value: 0.5, unit: 'V', guaranteed: true },
    ronMax: { value: 3, unit: 'ohm', guaranteed: true },
    operateTimeMax: { value: 1.5e-3, unit: 's', guaranteed: true },
    releaseTimeMax: { value: 2e-3, unit: 's', guaranteed: true },
    // The tables guarantee recovery only at 25 C. Requiring 80% of both recovery limits preserves
    // visible headroom against the temperature-characteristic trend without pretending it is a limit.
    temperatureGuard: { fraction: 0.8, engineeringBound: true },
  },
  gaqy212gs: {
    source: 'docs/datasheets/GAQY212GS_datasheet.pdf p.2',
    operateCurrentMax: { value: 2e-3, unit: 'A', guaranteed: true },
    recoveryCurrentMax: { value: 0.5e-3, unit: 'A', guaranteed: true },
    recoveryVoltageMin: { value: 0.7, unit: 'V', guaranteed: true },
    ronMax: { value: 0.6, unit: 'ohm', guaranteed: true },
    operateTimeMax: { value: 0.5e-3, unit: 's', guaranteed: true },
    releaseTimeMax: { value: 0.3e-3, unit: 's', guaranteed: true },
  },
  gaqw212gs: {
    source: 'docs/datasheets/GAQW212GS_datasheet.pdf p.2',
    operateCurrentMax: { value: 2e-3, unit: 'A', guaranteed: true },
    recoveryCurrentMax: { value: 0.5e-3, unit: 'A', guaranteed: true },
    recoveryVoltageMin: { value: 0.7, unit: 'V', guaranteed: true },
    ronMax: { value: 2, unit: 'ohm', guaranteed: true },
    operateTimeMax: { value: 0.5e-3, unit: 's', guaranteed: true },
    releaseTimeMax: { value: 0.3e-3, unit: 's', guaranteed: true },
  },
  g6k2fYDc12: {
    source: 'docs/datasheets/g6k_datasheet.pdf p.3',
    coilResistance: { nominal: 1315, tolerance: 0.10, unit: 'ohm', guaranteed: true },
    mustOperateVoltageMax: { value: 9.6, unit: 'V', guaranteed: true },
    mustReleaseVoltageMin: { value: 1.2, unit: 'V', guaranteed: true },
    operateTimeMax: { value: 3e-3, unit: 's', guaranteed: true },
    releaseTimeMax: { value: 3e-3, unit: 's', guaranteed: true },
    contactResistanceMax: { value: 0.1, unit: 'ohm', guaranteed: true },
  },
  esp32s3: {
    source: 'docs/datasheets/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf p.27',
    vdd: { min: 3.0, max: 3.6, unit: 'V', guaranteed: true },
    vihMinFractionVdd: { value: 0.75, guaranteed: true },
    vilMaxFractionVdd: { value: 0.25, guaranteed: true },
    inputLeakage: { min: -50e-9, max: 50e-9, unit: 'A', guaranteed: true },
    vohMinFractionVddAt40mA: { value: 0.8, guaranteed: true },
    // The output model anchors a Thevenin slope at the guaranteed 40 mA VOH point. It is an explicit
    // conservative model interpolation for the board's much lighter 6-10 mA PhotoMOS load.
    highSideRout: { value: (1 - 0.8) * 3.3 / 0.040, unit: 'ohm', engineeringBound: true },
  },
  sgm2212_3v3: {
    source: 'docs/datasheets/sgm2212_datasheet.pdf p.5',
    output: { min: 3.251, typ: 3.3, max: 3.349, unit: 'V', guaranteed: true },
  },
  tlp293gb: {
    source: 'docs/datasheets/tlp293_datasheet.pdf p.3',
    saturatedCtrMin: { value: 0.30, atIf: 1e-3, unit: 'ratio', guaranteed: true },
    darkCurrentMax85C: { value: 50e-6, unit: 'A', guaranteed: true },
    offCurrentMax: { value: 10e-6, unit: 'A', guaranteed: true },
  },
  fuse0466001: {
    source: 'docs/datasheets/littelfuse_0466_datasheet.pdf p.1',
    coldResistanceNominal: { value: 0.075, unit: 'ohm' },
    meltingI2tNominal: { value: 0.0423, unit: 'A2s' },
  },
  timingMlcc: {
    source: 'Samsung CL10A105KB8NNNC / CL10A225KO8NNNC: X5R, 16 V, +/-10%; public bias curves are typical',
    effectiveScale: { min: 0.65, max: 1.10, engineeringBound: true },
  },
  watchdogLoadedDrive: {
    source: 'full schematic deterministic endpoints at DOOR_DRV, including simultaneous K2/K4 LED loading',
    min: 2.98,
    max: 3.07,
    unit: 'V',
    engineeringBound: true,
  },
});

const gpioRout = PART_LIMITS.esp32s3.highSideRout.value;

export const CORNERS = freeze({
  actuatorDrive: {
    R4: { valueScale: 1.01 },
    R24: { valueScale: 1.01 },
    R5: { valueScale: 1.01 },
    R21: { valueScale: 1.01 },
    R6: { valueScale: 1.01 },
    R34: { valueScale: 1.01 },
    K1: {
      ledIs: diodeIsAt(1.4, 10e-3, 1.9),
      iOperate: PART_LIMITS.gaqw212gs.operateCurrentMax.value,
      tOperate: PART_LIMITS.gaqw212gs.operateTimeMax.value,
      ron: PART_LIMITS.gaqw212gs.ronMax.value,
    },
    K2: {
      ledIs: diodeIsAt(1.5, 10e-3, 1.9),
      iOperate: PART_LIMITS.gaqy212gs.operateCurrentMax.value,
      tOperate: PART_LIMITS.gaqy212gs.operateTimeMax.value,
      ron: PART_LIMITS.gaqy212gs.ronMax.value,
    },
    K3: {
      ledIs: diodeIsAt(1.5, 10e-3, 1.9),
      iOperate: PART_LIMITS.gaqy412eh.operateCurrentMax.value,
      tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value,
      ron: PART_LIMITS.gaqy412eh.ronMax.value,
    },
    K4: {
      ledIs: diodeIsAt(1.5, 10e-3, 1.9),
      iOperate: PART_LIMITS.gaqy412eh.operateCurrentMax.value,
      tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value,
      ron: PART_LIMITS.gaqy412eh.ronMax.value,
    },
    K6: {
      ledIs: diodeIsAt(1.5, 10e-3, 1.9),
      iOperate: PART_LIMITS.gaqy412eh.operateCurrentMax.value,
      tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value,
      ron: PART_LIMITS.gaqy412eh.ronMax.value,
    },
    U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.min, gpioRout },
    U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
  },
  watchdog: {
    nominal: {},
    fast: {
      R25: { valueScale: 0.99 },
      C20: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
      Q4: { vth: PART_LIMITS.ao3400a.vgsThreshold.min, gateLeakage: PART_LIMITS.ao3400a.gateLeakage.min },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.max, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.max },
    },
    slow: {
      R25: { valueScale: 1.01 },
      C20: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.max },
      Q4: { vth: PART_LIMITS.ao3400a.vgsThreshold.max, gateLeakage: PART_LIMITS.ao3400a.gateLeakage.max },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.min, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
  },
  doorLead: {
    // Minimum break-before-make lead: latest K4 opening, earliest K2 closure.
    minimumLead: {
      R17: { valueScale: 0.99 },
      C18: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
      Q3: { vth: PART_LIMITS.ao3400a.vgsThreshold.min, gateLeakage: PART_LIMITS.ao3400a.gateLeakage.min },
      K4: { tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value },
      K2: { tOperate: 0 },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.max, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.max },
    },
    latestMake: {
      R17: { valueScale: 1.01 },
      C18: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.max },
      Q3: { vth: PART_LIMITS.ao3400a.vgsThreshold.max, gateLeakage: PART_LIMITS.ao3400a.gateLeakage.max },
      K4: { tOperate: 0 },
      K2: { tOperate: PART_LIMITS.gaqy212gs.operateTimeMax.value },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.min, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
  },
  k6: {
    releasedSense: {
      R35: { valueScale: 1.01 },
      R44: { valueScale: 0.99 },
      U1: { inputLeakage: { '/K5_SENSE_N': PART_LIMITS.esp32s3.inputLeakage.max } },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
    activeSense: {
      R35: { valueScale: 0.99 },
      R44: { valueScale: 1.01 },
      U1: { inputLeakage: { '/K5_SENSE_N': PART_LIMITS.esp32s3.inputLeakage.min } },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.max },
      K5: {
        coilResistanceScale: 1.10,
        operateTime: PART_LIMITS.g6k2fYDc12.operateTimeMax.value,
        releaseTime: PART_LIMITS.g6k2fYDc12.releaseTimeMax.value,
        contactRon: PART_LIMITS.g6k2fYDc12.contactResistanceMax.value,
      },
    },
    gpioStuckLow: {
      R35: { valueScale: 1.01 },
      R44: { valueScale: 0.99 },
      K6: {
        iOperate: PART_LIMITS.gaqy412eh.operateCurrentMax.value,
        iRelease: PART_LIMITS.gaqy412eh.recoveryCurrentMin.value,
        vRelease: PART_LIMITS.gaqy412eh.recoveryVoltageMin.value,
        tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value,
        tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value,
        ron: PART_LIMITS.gaqy412eh.ronMax.value,
      },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.max, gpioLow: 0, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.max },
    },
    gpioStuckHigh: {
      R34: { valueScale: 1.01 },
      R44: { valueScale: 0.99 },
      K5: {
        coilResistanceScale: 1.10,
        operateTime: PART_LIMITS.g6k2fYDc12.operateTimeMax.value,
        releaseTime: PART_LIMITS.g6k2fYDc12.releaseTimeMax.value,
        contactRon: PART_LIMITS.g6k2fYDc12.contactResistanceMax.value,
      },
      K6: {
        ledIs: diodeIsAt(1.5, 10e-3, 1.9),
        iOperate: PART_LIMITS.gaqy412eh.operateCurrentMax.value,
        iRelease: PART_LIMITS.gaqy412eh.recoveryCurrentMin.value,
        vRelease: PART_LIMITS.gaqy412eh.recoveryVoltageMin.value,
        tOperate: PART_LIMITS.gaqy412eh.operateTimeMax.value,
        tRelease: PART_LIMITS.gaqy412eh.releaseTimeMax.value,
        ron: PART_LIMITS.gaqy412eh.ronMax.value,
      },
      U1: { gpioHigh: PART_LIMITS.sgm2212_3v3.output.min, gpioRout },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
  },
  optocoupler: {
    hotLeakage: {
      OC1: { ctr: PART_LIMITS.tlp293gb.saturatedCtrMin.value },
      U1: { inputLeakage: { '/P4_SENSE_N': PART_LIMITS.esp32s3.inputLeakage.min } },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
    dark: {
      OC1: { darkCurrent: PART_LIMITS.tlp293gb.darkCurrentMax85C.value },
      U1: { inputLeakage: { '/P4_SENSE_N': PART_LIMITS.esp32s3.inputLeakage.max } },
      U2: { vreg: PART_LIMITS.sgm2212_3v3.output.min },
    },
  },
  powerMonitor: {
    highReading: {
      R40: { valueScale: 0.99 },
      R41: { valueScale: 1.01 },
      U1: { inputLeakage: { '/VBUS_F_ADC': PART_LIMITS.esp32s3.inputLeakage.min } },
    },
    lowReading: {
      R40: { valueScale: 1.01 },
      R41: { valueScale: 0.99 },
      U1: { inputLeakage: { '/VBUS_F_ADC': PART_LIMITS.esp32s3.inputLeakage.max } },
    },
  },
  audioReceive: {
    highGain: {
      R30: { valueScale: 0.99 },
      R31: { valueScale: 0.99 },
      R32: { valueScale: 1.01 },
      R33: { valueScale: 1.01 },
      C16: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
      C17: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
    },
    lowGain: {
      R30: { valueScale: 1.01 },
      R31: { valueScale: 1.01 },
      R32: { valueScale: 0.99 },
      R33: { valueScale: 0.99 },
      C16: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
      C17: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
    },
  },
  audioTransmit: {
    highCoupling: {
      R26: { valueScale: 0.99 },
      R28: { valueScale: 0.99 },
      C14: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.max },
    },
    lowCoupling: {
      R26: { valueScale: 1.01 },
      R28: { valueScale: 1.01 },
      C14: { valueScale: PART_LIMITS.timingMlcc.effectiveScale.min },
    },
  },
});

// Reproducible PRNG used only by the optional Monte Carlo diagnostic. Safety gates use the explicit
// deterministic extremes above, never a random sample.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const uniform = (random, lo, hi) => lo + (hi - lo) * random();
