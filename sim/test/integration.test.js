// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
//
// Architecture under test (see DESIGN.md):
//  - K1/K2/K3/K4/K6 are PhotoMOS SSRs driven by GPIOs. K1 (dual NO) restores the V4.1 talk path:
//    ch1 /P2↔/TALK_BRIDGE, then R28 (2.2 k) to /TX_OUT; ch2 /TX_OUT↔/P3. K2 bridges /P2↔/P3
//    (door opener); K3 (NC) bridges /P4↔/CHIME_POS (chime); K4 (NC) breaks K5's seal-in for a
//    board-driven door release.
//  - K6 (NC) bridges raw /P4 to /K5_LATCH at rest. Its LED return passes through K5's spare NO pole,
//    so /P4_ISO cannot open K6 until K5 has physically pulled in. GPIO4 senses that return only
//    through R44 (100 k) against R35's pull-up, so no GPIO state can operate K6. JP2 is an open
//    recovery bypass.
//  - The embedded WF26 core (K5 latch + S1/S2 + C1) remains passive and works unpowered (SAFE-4).
//  - Audio is transformer-less: RX taps /P2 through C16 to the ES8311 ADC (MICP/MICN); TX runs the
//    codec DAC (OUTP) through R26 → C14 → /TALK_BRIDGE → R28 → /TX_OUT. Factory-bridged JP3 plus
//    R38+R39 (200 kΩ total) precharge /TALK_BRIDGE from /P2 before K1-ch1 closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNetlist } from '../src/import.js';
import { runDC, buildElements, defaultSwitchState, allComponents } from '../src/components/index.js';
import { createStepper, gndOf, simulate } from '../src/engine.js';

const netlist = importNetlist();
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

// peak-to-peak swing of (net a − net b) over the second half of a run (after any settling)
function swingPP(RES, a, b) {
  const va = RES.v[a];
  const vb = RES.v[b];

  let lo = Infinity;
  let hi = -Infinity;

  for (let i = Math.floor(va.length / 2); i < va.length; i++) {
    const d = va[i] - vb[i];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }

  return hi - lo;
}

// mean of (net a − net b) over the second half of a run (its DC level)
function meanLevel(RES, a, b) {
  const va = RES.v[a];
  const vb = RES.v[b];

  let sum = 0;
  let count = 0;

  for (let i = Math.floor(va.length / 2); i < va.length; i++) {
    sum += va[i] - vb[i];
    count++;
  }

  return sum / count;
}

// the loudspeaker's two terminals (LS1) — now across /P5 ↔ GND
const SPEAKER = Object.values(netlist.components.find((c) => c.ref === 'LS1').pins);
const AC = { T: 12 / 1000, dt: 1 / (1000 * 64) }; // a 1 kHz run with a settled second half

// Import sanity: every connected part must carry a library, so it can be classified rather than silently
// modelled as nothing. (importNetlist already throws on a part with no (comp) record at all; this also
// catches a record that parsed but lost its libsource — both should fail loudly, not slip through.)
test('import sanity: every component is parsed with a library (no silent drops)', () => {
  const empty = netlist.components.filter((c) => !c.lib);
  assert.equal(empty.length, 0, `components with no library: ${empty.map((c) => c.ref).join(', ') || '(none)'}`);
});

// ── embedded WF26 core (passive: must work with no board power, SAFE-4 / MODE-1) ──

test('SW3 (door release) pressed shorts P2 onto P3', () => {
  const { V } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { SW3: true } });
  assert.ok(near(V['/P3'], 12), `P3 should follow P2 to 12 V when S1 is pressed, got ${V['/P3']?.toFixed(3)}`);
});

test('SW3 released does NOT tie P3 to P2', () => {
  const { V, floating } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { SW3: false } });
  assert.ok(!near(V['/P3'], 12) || floating['/P3'],
    `P3 should not be at 12 V with S1 open, got ${V['/P3']?.toFixed(3)} (floating=${floating['/P3']})`);
});

test('SW4 (talk) pressed bridges line 4 onto line 3 through R1 (the handshake)', () => {
  // S2 connects /TALK_SW↔/P3; R29 (2.2 k) ties /P4↔/TALK_SW. So a held line 4
  // reaches line 3 through R1 when S2 is pressed — the handset's own DC talk handshake.
  const { V } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { SW4: true } });
  assert.ok(near(V['/P3'], 12, 1.0), `S2 pressed should bring P3 up toward line 4, got ${V['/P3']?.toFixed(3)}`);

  const { V: off } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { SW4: false } });
  assert.ok(!near(off['/P3'], 12, 1.0), `S2 released should leave P3 clear of line 4, got ${off['/P3']?.toFixed(3)}`);
});

test('SW4 dry pole provides named active-low PTT sense without a bus-line connection', () => {
  const byRef = Object.fromEntries(netlist.components.map((c) => [c.ref, c]));
  assert.equal(byRef.SW4.pins['1'], '/PTT_SW_N', 'SW4 NO1 must feed only the protected sense stub');
  assert.equal(byRef.SW4.pins['2'], 'GND', 'SW4 COM1 must be the logic-side ground reference');
  assert.equal(byRef.SW4.pins['3'], '/K1_LED_RET', 'SW4 NC1 must provide the smart-K1 LED return');
  assert.equal(byRef.U1.pins['24'], '/PTT_SENSE_N', 'GPIO47 must receive the protected PTT sense');
  assert.deepEqual(new Set(Object.values(byRef.R43.pins)), new Set(['/PTT_SENSE_N', '/PTT_SW_N']),
    'R43 must be the only series connection between GPIO47 and SW4 NO1');
  assert.deepEqual(new Set(Object.values(byRef.R42.pins)), new Set(['+3V3', '/PTT_SENSE_N']),
    'R42 must pull up the GPIO-side sense node (holds GPIO47 high through the switch transition)');

  const power = { '/VBUS': 5, '/P1': 0 };
  const released = runDC(netlist, { sources: power, switches: { SW4: false } }).V;
  const pressed = runDC(netlist, { sources: power, switches: { SW4: true } }).V;
  assert.ok(released['/PTT_SENSE_N'] > 2.475,
    `released PTT sense must exceed GPIO47 VIH, got ${released['/PTT_SENSE_N']?.toFixed(3)} V`);
  assert.ok(pressed['/PTT_SENSE_N'] < 0.825,
    `pressed PTT sense must stay below GPIO47 VIL through R43, got ${pressed['/PTT_SENSE_N']?.toFixed(3)} V`);
});

test('SW4 pressed hardware-inhibits smart K1 even if PTT_DRV remains high', () => {
  const scenario = {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 0 },
    program: { U1: { '/PTT_DRV': 3.3 } },
    T: 5e-3, // static PhotoMOS/contact state; no delayed RC or mechanical transition is under test
  };
  const released = runDC(netlist, { ...scenario, switches: { SW4: false } }).V;
  const pressed = runDC(netlist, { ...scenario, switches: { SW4: true } }).V;
  assert.ok(released['/P3'] > 10,
    `released SW4 must let K1 assert the smart handshake, got P3=${released['/P3']?.toFixed(3)} V`);
  assert.ok(pressed['/P3'] < 1,
    `pressed SW4 must open K1's LED return despite PTT_DRV high, got P3=${pressed['/P3']?.toFixed(3)} V`);
});

// ── bus rings heard at the loudspeaker. The acoustic path is passive, so it works powered or not. ──
const POWER = [
  ['powered (VBUS = 5 V)', { '/VBUS': 5 }],
  ['unpowered (no VBUS)', {}],
];

// apartment ring (Etagenruf): an AC tone on line 5 drives the loudspeaker (LS1 across /P5 ↔ GND).
for (const [pwr, power] of POWER) {
  test(`apartment ring: P5 tone reaches the loudspeaker — ${pwr}`, () => {
    const tone = (t) => 2 * Math.sin(2 * Math.PI * 1000 * t); // 2 V amplitude → 4 Vpp
    const { RES } = runDC(netlist, { sources: { ...power, '/P1': 0, '/P5': tone }, ...AC });
    assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) > 3.0,
      `LS1 should play the ~4 Vpp tone, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  });
}

// ringing the station (Türruf gong): line 4 held at 12 V DC with the gong tone on top. At rest K3 (NC)
// passes line 4 → /CHIME_POS; C19 (22 µF) couples the AC to /P5/LS1 and blocks the DC.
for (const [pwr, power] of POWER) {
  test(`ringing the station: P4 gong reaches the loudspeaker through K3+C1 — ${pwr}`, () => {
    const ring = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * 1000 * t); // 12 V DC + 1.5 V tone
    const { RES } = runDC(netlist, { sources: { ...power, '/P1': 0, '/P4': ring }, ...AC });
    assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) > 1.0,
      `the gong tone should couple through C1 to LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
    assert.ok(Math.abs(meanLevel(RES, SPEAKER[0], SPEAKER[1])) < 1.0,
      `C1 should block the 12 V DC (no cone offset), got ${meanLevel(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} V`);
  });
}

// ── call detection: the sense optocouplers (OC1 on line 4 = Türruf, OC2 on line 5 = Etagenruf) ──
// Each LED hangs off its bus line through a 5.1 kΩ limiter to P1; the phototransistor collector is
// pulled to +3V3 (12 kΩ) and read by the ESP, so a hot line pulls the GPIO low. Needs board power.

test('Türruf detection: a hot line 4 pulls P4_SENSE_N low; an idle line stays high', () => {
  const hot = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 12 } }).V;
  assert.ok(hot['/P4_SENSE_N'] < 1.0, `a ringing line 4 should pull P4_SENSE_N low, got ${hot['/P4_SENSE_N']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 0 } }).V;
  assert.ok(idle['/P4_SENSE_N'] > 3.0, `an idle line 4 should leave P4_SENSE_N high (~3V3), got ${idle['/P4_SENSE_N']?.toFixed(2)} V`);
});

test('Türruf detection: TLP293 GB guarantees LOW at the captured 1.1 mA LED-current corner', () => {
  // About 7 V through the fitted 5.1 kΩ limiter gives the captured low-end IF≈1.1 mA.
  // The model uses the TLP293 GB guaranteed 30% saturated CTR, not a typical curve.
  const lowLine = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 7 } }).V;
  assert.ok(lowLine['/P4_SENSE_N'] < 0.825,
    `low-line P4_SENSE_N must remain below ESP32 VIL(max), got ${lowLine['/P4_SENSE_N']?.toFixed(3)} V`);
});

test('Türruf detection: the 0 °C engineering CTR corner remains LOW', () => {
  // Toshiba's typical temperature curve is about 10% below its 25 °C value at 0 °C.
  const cold = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P4': 7 },
    program: { OC1: { ctr: 0.27 } },
  }).V;
  assert.ok(cold['/P4_SENSE_N'] < 0.825,
    `cold-corner P4_SENSE_N must remain below ESP32 VIL(max), got ${cold['/P4_SENSE_N']?.toFixed(3)} V`);
});

test('Etagenruf detection: a hot line 5 pulls P5_SENSE_N low; D9 blocks a reverse-polarity false trigger', () => {
  const hot = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': 12 } }).V;
  assert.ok(hot['/P5_SENSE_N'] < 1.0, `a ringing line 5 should pull P5_SENSE_N low, got ${hot['/P5_SENSE_N']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': 0 } }).V;
  assert.ok(idle['/P5_SENSE_N'] > 3.0, `an idle line 5 should leave P5_SENSE_N high, got ${idle['/P5_SENSE_N']?.toFixed(2)} V`);

  // reverse voltage on line 5: D9 (anti-parallel to the LED) shunts it, so the LED never lights
  const rev = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': -12 } }).V;
  assert.ok(rev['/P5_SENSE_N'] > 3.0, `reverse polarity must not trigger OC2 (LED protected by D9), got ${rev['/P5_SENSE_N']?.toFixed(2)} V`);
});

// ── actuators (PhotoMOS SSRs, energised via /PTT_DRV /DOOR_DRV /MUTE_DRV through 220 Ω LED resistors) ──

test('FW-3: V4.2 PhotoMOS drives retain 220 Ω fanout, operate-current margin and GPIO headroom', () => {
  const paths = {
    '/PTT_DRV': [['R4', '/K1A_A'], ['R24', '/K1B_A']],
    '/DOOR_DRV': [['R5', '/K2_A'], ['R21', '/K4_A']],
    '/MUTE_DRV': [['R6', '/K3_A']],
    '/P4_ISO': [['R34', '/K6_A']],
  };
  for (const [drive, resistors] of Object.entries(paths)) {
    for (const [ref, ledAnode] of resistors) {
      const r = netlist.components.find((c) => c.ref === ref);
      assert.equal(r.value, '220', `${ref} must remain 220 Ω`);
      assert.deepEqual(new Set(Object.values(r.pins)), new Set([drive, ledAnode]),
        `${ref} must connect ${drive} to ${ledAnode}`);
    }
  }

  const settle = ({ program, sources = {}, T = 5e-3 }) => {
    const els = buildElements(netlist, { switchState: defaultSwitchState(netlist), program: { U1: program } });
    const sim = createStepper(els, Object.entries({ '/VBUS': 5, '/P1': 0, ...sources }).map(([net, v]) => ({
      net,
      vf: typeof v === 'function' ? v : () => v,
    })), gndOf(netlist), 20e-6);
    for (let t = 0; t < T; t += 20e-6) sim.step(t);
    return sim;
  };
  const ledCurrent = (sim, ref) => Math.abs(
    sim.padInjections().find((p) => p.ref === ref && p.pin === '2')?.I || 0,
  );
  const gpioLoad = (sim, net) => -sim.padInjections()
    .filter((p) => p.net === net && p.I < 0)
    .reduce((sum, p) => sum + p.I, 0);
  const assertOperateMargin = (sim, refs) => {
    for (const ref of refs) {
      const current = ledCurrent(sim, ref);
      assert.ok(current >= 5e-3,
        `${ref} LED must receive at least the 5 mA recommended floor, got ${(current * 1e3).toFixed(2)} mA`);
    }
  };

  const ptt = settle({ program: { '/PTT_DRV': 3.3 } });
  assertOperateMargin(ptt, ['R4', 'R24']);
  assert.ok(ptt.extractState().ssrs.K1, 'both K1 channels must operate from PTT_DRV');
  assert.ok(gpioLoad(ptt, '/PTT_DRV') <= 18e-3,
    `PTT_DRV must stay within its ~18 mA design load, got ${(gpioLoad(ptt, '/PTT_DRV') * 1e3).toFixed(2)} mA`);

  const door = settle({ program: { '/DOOR_DRV': 3.3 }, T: 0.1 }); // includes K2's deliberate RC delay
  assertOperateMargin(door, ['R5', 'R21']);
  assert.ok(door.extractState().ssrs.K2 && door.extractState().ssrs.K4,
    'DOOR_DRV must operate both the delayed K2 make and immediate K4 break');
  assert.ok(gpioLoad(door, '/DOOR_DRV') <= 18e-3,
    `DOOR_DRV must stay within its ~18 mA design load, got ${(gpioLoad(door, '/DOOR_DRV') * 1e3).toFixed(2)} mA`);

  const mute = settle({ program: { '/MUTE_DRV': 3.3 } });
  assertOperateMargin(mute, ['R6']);
  assert.ok(mute.extractState().ssrs.K3, 'MUTE_DRV must operate K3');

  const isolate = settle({
    program: { '/P4_ISO': 3.3 },
    sources: { '/P2': 12, '/P4': (t) => (t >= 5e-3 && t < 17e-3 ? 12 : 0) },
    T: 0.05,
  });
  assert.ok(isolate.extractState().relays.K5, 'the K5 auxiliary contact must close the K6 LED return');
  assertOperateMargin(isolate, ['R34']);
  assert.ok(isolate.extractState().ssrs.K6, 'P4_ISO must operate K6 once K5 is confirmed');
});

test('K2 door opener: DOOR_DRV = 3.3 V bridges P2 onto P3; idle does not', () => {
  // R17·C18 delays K2's make ~31 ms behind DOOR_DRV (vth-dependent); T=0.1 s leaves ample settling headroom
  const on = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/DOOR_DRV': 3.3 } }, T: 0.1 }).V;
  assert.ok(near(on['/P3'], 12), `energised K2 should tie P3 to P2 (12 V), got ${on['/P3']?.toFixed(3)}`);

  const off = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/DOOR_DRV': 0 } } }).V;
  assert.ok(!near(off['/P3'], 12), `idle K2 should not tie P3 to 12 V, got ${off['/P3']?.toFixed(3)}`);
});

test('K2 door fail-safe: an unpowered board cannot bridge P2→P3 (door stays shut at boot/fault, SAFE-6)', () => {
  // no VBUS, no GPIO drive — K2 (1-Form-A NO) is open, so the door bridge can never form unpowered
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/P2': 12 } });
  assert.ok(!near(V['/P3'], 12, 1.0), `unpowered K2 must leave P2↔P3 open, got ${V['/P3']?.toFixed(2)} V`);
});

// chime suppress (K3, NC): at rest it passes the gong AND OC1 keeps detecting (OC1 is on line 4 itself,
// ahead of K3). Energising K3 opens line 4 → /CHIME_POS, silencing the chime while detection survives.
const gong = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * 1000 * t); // incoming Türruf: 12 V DC + gong tone

test('chime suppress: K3 idle passes the gong to the speaker AND OC1 still detects it', () => {
  const { V, RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': gong }, ...AC }); // MUTE_DRV unset → K3 idle (NC closed)
  assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) > 1.0,
    `K3 idle should let the gong reach LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  assert.ok(V['/P4_SENSE_N'] < 1.0, `OC1 should detect the ring, got ${V['/P4_SENSE_N']?.toFixed(2)} V`);
});

test('chime suppress: K3 energised silences the speaker but OC1 keeps detecting', () => {
  const { V, RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': gong }, program: { U1: { '/MUTE_DRV': 3.3 } }, ...AC }); // K3 opened
  assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) < 0.5,
    `K3 energised should silence the chime at LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  assert.ok(V['/P4_SENSE_N'] < 1.0, `detection must survive suppression (OC1 on line 4, ahead of K3), got ${V['/P4_SENSE_N']?.toFixed(2)} V`);
});

test('chime suppress fail-safe: line 4 stays bridged to C1 when the ESP is unpowered (K3 NC closed)', () => {
  // no VBUS → the ESP can never open K3, so the gong path (line 4 → /CHIME_POS) must stay made
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } });
  assert.ok(near(V['/CHIME_POS'], 12), `unpowered, K3 NC must bridge line 4 → /CHIME_POS, got ${V['/CHIME_POS']?.toFixed(2)} V`);
});

test('JP1 chime bleed is factory bridged and connects R36 to GND', () => {
  const jp1 = netlist.components.find((c) => c.ref === 'JP1');
  assert.equal(defaultSwitchState(netlist).JP1, true, 'JP1 must be factory bridged');
  assert.deepEqual(new Set(Object.values(jp1.pins)), new Set(['GND', '/CHIME_BLEED_RET']));
  const r36 = netlist.components.find((c) => c.ref === 'R36');
  assert.deepEqual(new Set(Object.values(r36.pins)), new Set(['/CHIME_POS', '/CHIME_BLEED_RET']),
    'R36 must bleed CHIME_POS through factory-bridged JP1');
});

const chimePhase = ({ mute, sources, T, seed, observe = false, step = 20e-6, jp1 = true }) => {
    const switchState = { ...defaultSwitchState(netlist), JP1: jp1 };
    const els = buildElements(netlist, { switchState, program: { U1: { '/MUTE_DRV': mute ? 3.3 : 0 } } });
    const sim = createStepper(
      els,
      Object.entries(sources).map(([net, v]) => ({ net, vf: () => v })),
      gndOf(netlist),
      step,
      seed,
    );
    let peakP4 = -Infinity;
    let relatched = false;
    for (let t = 0; t < T; t += step) {
      sim.step(t);
      if (observe) {
        peakP4 = Math.max(peakP4, sim.vn[sim.ni['/P4']] ?? 0);
        relatched ||= Boolean(sim.extractState().relays.K5);
      }
    }
    return { state: sim.extractState(), peakP4, relatched };
};

const trappedChimeCharge = ({ jp1 = true } = {}) => {
  // Charge the gong coupling capacitors from a real ring with K3 closed, then open K3 while the
  // ring is still present. Ending the session with P2 low drops K5 but leaves CHIME_POS isolated and
  // charged. Reclosing the NC contact later must not turn that stored charge into another pull-in.
  const ringing = chimePhase({ mute: false, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }, T: 0.02, jp1 });
  return chimePhase({ mute: true, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }, T: 0.005, seed: ringing.state, jp1 }).state;
};

const endAndRecloseChime = ({ charged, wait, jp1 = true }) => {
  const ended = chimePhase({ mute: true, sources: { '/VBUS': 5, '/P1': 0, '/P2': 0 }, T: wait, step: wait > 0.1 ? 5e-3 : 20e-6, seed: charged, jp1 });
  assert.equal(ended.state.relays.K5, false, 'the original ring/session must be over before the reclose check');
  return chimePhase({ mute: false, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, T: 0.05, seed: ended.state, observe: true, jp1 });
};

test('chime suppress transition: immediate K3 reclose cannot accumulate enough K5 pickup force', () => {
  const reclosed = endAndRecloseChime({ charged: trappedChimeCharge(), wait: 0.02 });
  assert.equal(reclosed.relatched, false, 'the decaying C1 reclose pulse must not accumulate enough coil force to operate K5');
  assert.ok(reclosed.peakP4 > 9.6, `expected a K5-operate-level P4 pulse, got ${reclosed.peakP4.toFixed(2)} V`);
});

test('chime suppress transition: JP1 cut retains charge but still cannot re-latch K5', () => {
  const reclosed = endAndRecloseChime({ charged: trappedChimeCharge({ jp1: false }), wait: 12, jp1: false });
  assert.equal(reclosed.relatched, false, 'stored C1 charge must not operate K5 even with the bleed deliberately cut');
  assert.ok(reclosed.peakP4 > 9.6, `the diagnostic control should retain a pickup-level pulse, got ${reclosed.peakP4.toFixed(2)} V`);
});

test('chime suppress transition: both fresh and bled charge are harmless to K5', () => {
  const waits = [0.02, 2.4, 4.8, 7.2, 12];
  const results = waits.map((wait) => ({ wait, result: endAndRecloseChime({ charged: trappedChimeCharge(), wait }) }));
  assert.ok(results.every(({ result }) => !result.relatched),
    `the reclose pulse must never operate K5: ${results.map(({ wait, result }) => `${wait}s=${result.relatched}`).join(', ')}`);
});

test('chime suppress transition: R36 still reduces the reclose pulse after five time constants', () => {
  // R36 is a passive robustness bleed, not a required firmware safety timer.  Five time constants
  // (~12 s) should nevertheless leave only a small residual reclose pulse.
  const reclosed = endAndRecloseChime({ charged: trappedChimeCharge(), wait: 12 });
  assert.equal(reclosed.relatched, false, `a bled reclose must not operate K5 (P4 peak ${reclosed.peakP4.toFixed(2)} V)`);
  assert.ok(reclosed.peakP4 < 1.5, `R36 should substantially bleed CHIME_POS by 12 s, got ${reclosed.peakP4.toFixed(2)} V`);
});

// Safety invariant (GONG requirement — the Etagenruf must always ring): the Etagenruf (apartment
// door — someone physically at your own door) reaches LS1 directly on line 5, bypassing K3, so it is
// *structurally* non-suppressible. K3 can mute only the Türruf (through C1). The guarantee is hardware,
// not firmware — so it must hold even in the very state that suppresses the Türruf.
test('Etagenruf is structurally non-suppressible: K3 energised mutes the Türruf but not line 5', () => {
  const tone = (t) => 2 * Math.sin(2 * Math.PI * 1000 * t);
  const ring = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * 1000 * t);
  // in the suppressing state, the Türruf gong on line 4 is muted ...
  const turruf = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': ring }, program: { U1: { '/MUTE_DRV': 3.3 } }, ...AC }).RES;
  assert.ok(swingPP(turruf, SPEAKER[0], SPEAKER[1]) < 0.5,
    `K3 energised should mute the Türruf, got ${swingPP(turruf, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  // ... yet the Etagenruf on line 5 stays audible in that same state
  const etagen = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': tone }, program: { U1: { '/MUTE_DRV': 3.3 } }, ...AC }).RES;
  assert.ok(swingPP(etagen, SPEAKER[0], SPEAKER[1]) > 3.0,
    `the Etagenruf must stay audible while K3 suppresses, got ${swingPP(etagen, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
});

// ── K5-confirmed P4 isolation (V4.2 hardware; firmware remains intentionally deferred) ──

test('K6 fail-safe: an unpowered board connects raw P4 to K5_LATCH', () => {
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 }, switches: { JP2: false }, T: 10e-3 });
  assert.ok(near(V['/K5_LATCH'], 12, 0.5),
    `K6 is NC and must pass a ring without board power, got K5_LATCH=${V['/K5_LATCH']?.toFixed(2)} V`);
});

test('K6 interlock: isolation opens only after K5 pulls in, preserves seal-in, and restores on release', () => {
  const els = buildElements(netlist, {
    switchState: { ...defaultSwitchState(netlist), JP2: false },
    program: { U1: { '/P4_ISO': 3.3 } },
  });
  const dt = 20e-6;
  const sim = createStepper(els, [
    { net: '/VBUS', vf: () => 5 },
    { net: '/P1', vf: () => 0 },
    { net: '/P2', vf: (t) => (t < 40e-3 ? 12 : 0) },
    { net: '/P4', vf: (t) => (t >= 5e-3 && t < 17e-3 ? 12 : 0) },
  ], gndOf(netlist), dt);

  let openedBeforeK5 = false;
  let seenK5 = false;
  let held;
  for (let t = 0; t < 55e-3; t += dt) {
    sim.step(t);
    const state = sim.extractState();
    seenK5 ||= Boolean(state.relays.K5);
    openedBeforeK5 ||= Boolean(state.ssrs.K6 && !seenK5);
    if (t >= 30e-3 && !held) held = state;
  }
  const released = sim.extractState();

  assert.equal(openedBeforeK5, false, 'K5 auxiliary NO must block K6 LED current until K5 has pulled in');
  assert.ok(held.relays.K5, 'K5 must remain sealed from P2 after raw P4 is isolated');
  assert.ok(held.ssrs.K6, 'K6 LED must be energised (NC output open) while K5 is confirmed');
  assert.ok(held.vn['/K5_SENSE_N'] < 0.5, `K5_SENSE_N must be active-low, got ${held.vn['/K5_SENSE_N']?.toFixed(2)} V`);
  assert.ok(held.vn['/K5_LATCH'] > 8, `the isolated latch node must remain held from P2, got ${held.vn['/K5_LATCH']?.toFixed(2)} V`);
  assert.equal(released.relays.K5, false, 'driving P2 low must release K5');
  assert.equal(released.ssrs.K6, false, 'loss of K5 must interrupt K6 LED current and restore its NC output');
});

test('JP2 recovery bypass is open by default and directly spans K6 output', () => {
  const jp2 = netlist.components.find((c) => c.ref === 'JP2');
  assert.equal(defaultSwitchState(netlist).JP2, undefined, 'JP2 must not be factory bridged');
  assert.equal(jp2.pins['1'], '/K5_LATCH');
  assert.equal(jp2.pins['2'], '/P4');
  const k6 = netlist.components.find((c) => c.ref === 'K6');
  assert.equal(k6.pins['3'], '/K5_LATCH');
  assert.equal(k6.pins['4'], '/P4');
});

test('JP2 recovery: bridging the jumper restores the passive ring path across a dead K6', () => {
  // `omit` drops K6 entirely — a failed-open isolator (contact stuck open, LED dark), the fault JP2
  // exists to recover from. Unpowered (SAFE-4): the ring path is broken until the jumper is bridged.
  const dead = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 }, omit: ['K6'], T: 10e-3 });
  assert.ok(!near(dead.V['/K5_LATCH'], 12, 1.0) || dead.floating['/K5_LATCH'],
    `a failed-open K6 must break raw P4 → K5_LATCH, got ${dead.V['/K5_LATCH']?.toFixed(2)} V`);

  const bridged = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 }, switches: { JP2: true }, omit: ['K6'], T: 10e-3 });
  assert.ok(near(bridged.V['/K5_LATCH'], 12, 0.5),
    `bridged JP2 must restore raw P4 → K5_LATCH across the dead K6, got ${bridged.V['/K5_LATCH']?.toFixed(2)} V`);
  assert.ok(near(bridged.V['/SEAL_IN'], 12, 1.0),
    `the restored ring must still pull K5 in (COM onto line 4), got ${bridged.V['/SEAL_IN']?.toFixed(2)} V`);
});

// ── K5 sense decoupling (R44): GPIO4 observes the K6 LED return but can never power it. R35 biases
// /K6_RET (the LED-cathode / K5-aux node); GPIO4 hangs alone behind R44, so a low GPIO forms only the
// weak R35:R44 divider — the LED stays under its guaranteed-recovery corner (< 0.5 V / < 0.1 mA). ──

test('K5 sense decoupling: R44 alone links GPIO4 to the K6 LED return, R35 biases the return side', () => {
  const byRef = Object.fromEntries(netlist.components.map((c) => [c.ref, c]));
  assert.equal(byRef.U1.pins['4'], '/K5_SENSE_N', 'GPIO4 must receive the decoupled K5 sense');
  assert.equal(byRef.R44.value, '100k', 'R44 must stay 100 kΩ — the ratio against R35 sets the fault-case LED voltage');
  assert.deepEqual(new Set(Object.values(byRef.R44.pins)), new Set(['/K5_SENSE_N', '/K6_RET']),
    'R44 must be the only series connection between GPIO4 and the K6 LED return');
  assert.deepEqual(new Set(Object.values(byRef.R35.pins)), new Set(['+3V3', '/K6_RET']),
    'R35 must pull up K6_RET (the LED-return node), NOT the GPIO-side sense net');
  assert.equal(byRef.K6.pins['2'], '/K6_RET', 'K6 LED cathode must return through the aux-contact node');
  assert.equal(byRef.K5.pins['5'], '/K6_RET', 'K5 auxiliary NO must gate the LED return directly');

  // sense function across relay states: released reads above VIH, sealed reads below VIL through R44
  const released = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, T: 0.05 }).V;
  assert.ok(released['/K5_SENSE_N'] > 2.475,
    `released K5 must read above GPIO4 VIH, got ${released['/K5_SENSE_N']?.toFixed(3)} V`);
  const sealed = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': (t) => (t >= 5e-3 && t < 17e-3 ? 12 : 0) },
    T: 0.05,
  }).V;
  assert.ok(sealed['/K5_SENSE_N'] < 0.825,
    `sealed K5 must read below GPIO4 VIL through R44, got ${sealed['/K5_SENSE_N']?.toFixed(3)} V`);
});

test('K5 sense fault: a stuck-low GPIO4 cannot operate K6 or block the next ring', () => {
  // Double fault: firmware asserts P4_ISO while GPIO4 is misconfigured/damaged hard-low and K5 is
  // released. The model alone can't prove this (its operate threshold is the 3 mA guaranteed-operate
  // corner), so assert the LED bias directly against the datasheet recovery limits: < 0.5 V forward
  // and < 0.1 mA. Then let a Türruf arrive mid-fault and require the still-closed K6 to pass it.
  const els = buildElements(netlist, {
    switchState: { ...defaultSwitchState(netlist), JP2: false },
    program: { U1: { '/P4_ISO': 3.3, '/K5_SENSE_N': 0 } },
  });
  const dt = 20e-6;
  const sim = createStepper(els, [
    { net: '/VBUS', vf: () => 5 },
    { net: '/P1', vf: () => 0 },
    { net: '/P2', vf: () => 12 },
    { net: '/P4', vf: (t) => (t >= 25e-3 ? 12 : 0) }, // the ring arrives while the fault persists
  ], gndOf(netlist), dt);

  let faulted; let iLed; let rang = false;
  for (let t = 0; t < 50e-3; t += dt) {
    sim.step(t);
    const state = sim.extractState();
    if (t >= 20e-3 && !faulted) {
      faulted = state; // settled fault, ring not yet arrived
      iLed = Math.abs(sim.padInjections().find((p) => p.ref === 'R34' && p.pin === '1')?.I || 0);
    }
    rang ||= Boolean(state.relays.K5);
  }

  assert.equal(faulted.ssrs.K6, false, 'K6 must stay closed (NC) under the GPIO4-low fault');
  const vLed = faulted.vn['/K6_A'] - faulted.vn['/K6_RET'];
  assert.ok(vLed < 0.5,
    `K6 LED must stay under its 0.5 V guaranteed-recovery voltage, got ${vLed.toFixed(3)} V`);
  assert.ok(iLed < 1e-4,
    `K6 LED current must stay under the 0.1 mA guaranteed-recovery floor, got ${(iLed * 1e6).toFixed(1)} µA`);
  assert.ok(rang, 'a Türruf during the fault must still reach K5 through closed K6 and pull it in');
});

test('K5 sense fault: a stuck-high GPIO4 cannot defeat isolation or stress the aux contact', () => {
  // Opposite fault: GPIO4 driving 3.3 V while a real session isolates. The aux contact still returns
  // the LED (K6 operates normally); the GPIO can only source ~33 µA through R44 into the contact.
  const els = buildElements(netlist, {
    switchState: { ...defaultSwitchState(netlist), JP2: false },
    program: { U1: { '/P4_ISO': 3.3, '/K5_SENSE_N': 3.3 } },
  });
  const dt = 20e-6;
  const sim = createStepper(els, [
    { net: '/VBUS', vf: () => 5 },
    { net: '/P1', vf: () => 0 },
    { net: '/P2', vf: () => 12 },
    { net: '/P4', vf: (t) => (t >= 5e-3 && t < 17e-3 ? 12 : 0) },
  ], gndOf(netlist), dt);
  for (let t = 0; t < 40e-3; t += dt) sim.step(t);

  const state = sim.extractState();
  assert.ok(state.relays.K5, 'K5 must still latch and seal from P2');
  assert.ok(state.ssrs.K6, 'a confirmed K5 must still let P4_ISO operate K6 despite the sense fault');
  const iGpio = Math.abs(sim.padInjections().find((p) => p.ref === 'R44' && p.pin === '2')?.I || 0);
  assert.ok(iGpio < 5e-5,
    `a driven-high GPIO4 must source under 50 µA into the closed aux contact, got ${(iGpio * 1e6).toFixed(1)} µA`);
});

// ── audio (transformer-less codec front-end). Exact gains are bench-gated; here we assert the path
// couples (or doesn't), not its level. ──

test('codec record (RX): line 2 reaches the mic inputs, attenuated ~-18 dB by the input divider', () => {
  // RX path per leg: /P2 → C16 → R30 (22k) → MICP, with R33 (3.3k) shunting MICP to VMID (mirror on
  // MICN: GND → C17 → R31 → MICN, R32 to VMID). The 22k/3.3k series+shunt is a divider that drops the
  // bus before the codec (gong-safety): ratio = 3.3/(22+3.3) ≈ 0.130. Assert the ratio, not just that
  // the path couples — so removing/shorting the divider (ratio → 1.0) fails here.
  const tone = (t) => 1.0 * Math.sin(2 * Math.PI * 1000 * t); // 2 Vpp on the line
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': tone }, ...AC });
  const mic = swingPP(RES, '/ES_MICP', '/ES_MICN');
  const line = swingPP(RES, '/P2', '/P1');
  assert.ok(mic > 0.1, `line-2 audio should still reach the codec ADC, got ${mic.toFixed(3)} Vpp`);
  const ratio = mic / line;
  assert.ok(near(ratio, 0.130, 0.03),
    `RX divider should attenuate ~-18 dB (3.3k/25.3k = 0.130), got ${ratio.toFixed(3)} ` +
    `(mic ${mic.toFixed(3)} Vpp / line ${line.toFixed(2)} Vpp)`);
});

// The reason the RX divider + VMID bias exist (review blocker): the bench-measured ±8.8 V Türruf gong
// on line 2 is 2.4× the ES8311 mic abs-max (AVDD+0.3). With the VMID reference modelled, assert the
// safety property directly — the divider drops the gong and the VMID bias centres it, so the absolute
// mic-pin voltage stays inside the analog rail [0, AVDD] and the input ESD clamps never conduct.
// Longer run (40 ms) so VMID settles against C12 before the measured second half.
test('RX gong-safety: a ±8.8 V line-2 gong keeps MIC1P/N inside [0, AVDD] (no clamp conduction)', () => {
  const gong = (t) => 8.8 * Math.sin(2 * Math.PI * 1000 * t);
  // feed only VBUS (external); the modelled power tree brings up the codec's supplies — +5V via F1,
  // +3V3 (DVDD/PVDD) via U2, and AVDD via the LP5907 (+5V → U4 → AVDD_PRE → D18 → AVDD)
  const { RES, V, floating } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': gong },
    T: 40 / 1000, dt: 1 / (1000 * 64),
  });
  const avdd = V['/AVDD'];
  assert.ok(!floating['/ES_VMID'] && near(V['/ES_VMID'], avdd / 2, 0.2),
    `VMID should be biased to ~AVDD/2, got ${V['/ES_VMID']?.toFixed(3)} V (AVDD ${avdd?.toFixed(2)})`);
  const range = (net) => {
    const a = RES.v[net];
    let lo = Infinity, hi = -Infinity;
    for (let i = a.length >> 1; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
    return [lo, hi];
  };
  for (const net of ['/ES_MICP', '/ES_MICN']) {
    const [lo, hi] = range(net);
    assert.ok(lo > 0 && hi < avdd,
      `${net} must stay within the codec rail [0, ${avdd.toFixed(2)}] under the gong (abs-max), ` +
      `got [${lo.toFixed(2)}, ${hi.toFixed(2)}] V`);
  }
});

// Beyond magnitude (the ratio test above) and abs-max (the gong test above): confirm the tap delivers a
// PROPER differential signal — the bus drive lands on MICP (the live leg) while MICN stays near its VMID
// reference, and both pins DC-bias to VMID. swingPP needs a settled run (40 ms) so the VMID/C12 charge
// ramp doesn't masquerade as signal. KNOWN GAP: true common-mode rejection (the other half of "proper")
// is NOT tested — /P1 is merged into GND in the netlist, so there's no distinct reference node to apply a
// common-mode to. Testing it would need P1 modelled as its own node bonded to GND through an impedance.
test('RX differential: the live signal lands on MICP; MICN stays the quiet VMID reference', () => {
  const tone = (t) => 8.8 * Math.sin(2 * Math.PI * 1000 * t); // strong drive so MICN's ~0.1 Vpp floor is subdominant
  const { RES, V } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': tone }, // VBUS only; the tree powers the codec (incl. AVDD via the LP5907)
    T: 40 / 1000, dt: 1 / (1000 * 64),
  });
  const span = (net) => {
    const a = RES.v[net];
    let lo = Infinity, hi = -Infinity;
    for (let i = a.length >> 1; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
    return { swing: hi - lo, dc: (lo + hi) / 2 };
  };
  const p = span('/ES_MICP'), n = span('/ES_MICN'), vmid = V['/ES_VMID'];
  // the signal lands on MICP; MICN is the reference, a small fraction of MICP's swing
  assert.ok(n.swing < 0.25 * p.swing,
    `signal should be on MICP with MICN quiet, got MICP ${p.swing.toFixed(2)} / MICN ${n.swing.toFixed(2)} Vpp`);
  // both inputs DC-bias to VMID (the ES8311 has no internal mic bias; R32/R33 set it)
  assert.ok(near(p.dc, vmid, 0.2) && near(n.dc, vmid, 0.2),
    `MICP/MICN should bias to VMID (${vmid?.toFixed(2)} V), got MICP ${p.dc.toFixed(2)} / MICN ${n.dc.toFixed(2)} V`);
});

test('codec clamps reference AVDD behind reverse blocking and a defined bleeder', () => {
  const byRef = Object.fromEntries(netlist.components.map((c) => [c.ref, c]));
  assert.deepEqual(byRef.D13.pins, { '1': '/AVDD', '2': '/ES_OUTP' },
    'D13 must clamp OUTP upward into AVDD');
  assert.deepEqual(byRef.D16.pins, { '1': '/ES_OUTP', '2': 'GND' },
    'D16 must clamp OUTP downward into GND');
  assert.deepEqual(byRef.D14.pins, { '1': '/AVDD', '2': '/ES_MICP' },
    'D14 must clamp MIC1P upward into AVDD');
  assert.deepEqual(byRef.D17.pins, { '1': '/ES_MICP', '2': 'GND' },
    'D17 must clamp MIC1P downward into GND');
  for (const ref of ['D13', 'D14', 'D16', 'D17', 'D18'])
    assert.equal(byRef[ref].value, 'LMBR01S30ST5G', `${ref} must use the specified low-Vf diode`);
  assert.equal(byRef.D18.pins['2'], 'AVDD_PRE', 'D18 anode must face the LP5907 output');
  assert.equal(byRef.D18.pins['1'], '/AVDD', 'D18 cathode must face AVDD and block reverse current');
  assert.deepEqual(new Set(Object.values(byRef.R37.pins)), new Set(['/AVDD', 'GND']),
    'R37 must provide the explicit AVDD-to-ground sink');

  const powered = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 } }).V;
  assert.ok(powered['/AVDD'] >= 1.7 && powered['/AVDD'] <= 3.6,
    `powered AVDD must remain in the ES8311 operating range, got ${powered['/AVDD']?.toFixed(3)} V`);
});

test('K5 clamp uses the 1N4004W with cathode on K5_LATCH', () => {
  const byRef = Object.fromEntries(netlist.components.map((c) => [c.ref, c]));
  assert.equal(byRef.D1.value, '1N4004W', 'D1 must be the sustained-current rectifier, not a switching diode');
  assert.deepEqual(byRef.D1.pins, { '1': '/K5_LATCH', '2': 'GND' },
    'D1 cathode must face K5_LATCH and its anode must return to P1/GND');
  const d1 = Object.fromEntries(allComponents(netlist).map((c) => [c.ref, c])).D1;
  assert.equal(d1.model().vrr, 400, 'the simulator must retain D1\'s 400 V reverse rating');
});

test('codec clamp qualification records the 25 °C guarantee and bounds fault current', () => {
  const components = Object.fromEntries(allComponents(netlist).map((c) => [c.ref, c]));
  const spec = components.D13.model().qualification;
  assert.deepEqual(spec, {
    vfMax: 0.30,
    vfTestCurrent: 0.010,
    vfSpecifiedTempC: [25, 25],
  }, 'the simulator must retain the exact forward-voltage condition from the diode datasheet');

  // Even a conservative V/R bound (ignoring the clamp drop) stays below the datasheet's 10 mA
  // test point. That supports the current axis of the comparison for both TX and RX fault paths.
  const txFaultCurrent = 17 / components.R26.val();
  const rxFaultCurrent = 17 / components.R30.val();
  assert.ok(txFaultCurrent <= spec.vfTestCurrent,
    `R26 must keep the 17 V TX fault at or below 10 mA, got ${(txFaultCurrent * 1e3).toFixed(2)} mA`);
  assert.ok(rxFaultCurrent <= spec.vfTestCurrent,
    `R30 must keep the 17 V RX fault at or below 10 mA, got ${(rxFaultCurrent * 1e3).toFixed(2)} mA`);

});

test('unpowered C14-short fault cannot overdrive the codec or phantom-power the board', () => {
  for (const bus of [-17, 17]) {
    // Driving ES_OUTP_AC directly models C14 shorted with the measured bus envelope applied on its
    // bus side. R26, D13/D16, R37 and D18 are the complete remaining protection path.
    const V = runDC(netlist, { sources: { '/P1': 0, '/ES_OUTP_AC': bus }, T: 0.1 }).V;
    assert.ok(V['/ES_OUTP'] >= -0.3 && V['/ES_OUTP'] <= V['/AVDD'] + 0.3,
      `${bus} V fault must keep OUTP inside [AGND-0.3, AVDD+0.3], got OUTP ` +
      `${V['/ES_OUTP']?.toFixed(3)} V / AVDD ${V['/AVDD']?.toFixed(3)} V`);
    assert.ok(V['/AVDD'] < 1.7,
      `${bus} V fault must keep unpowered AVDD below codec turn-on, got ${V['/AVDD']?.toFixed(3)} V`);
    assert.ok(Math.abs(V['+5V']) < 0.05 && Math.abs(V['+3V3']) < 0.05,
      `${bus} V fault must not phantom-power the board, got +5V ${V['+5V']?.toFixed(3)} / ` +
      `+3V3 ${V['+3V3']?.toFixed(3)} V`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety invariants — class-owned absolute-maximum containment sweep.
// Each device class declares its OWN limits (Component.checkSafe), expressed against its own supply/
// ground pins — so there is no net registry to drift, and a fault on ANY part in ANY scenario is caught.
// A scenario injects ONLY the real external rails: VBUS, GND, and the bus lines the TV20/S drives
// (P2..P5) — the latter behind the measured bus source impedance, not as a zero-Ω ideal source (which
// would shunt the codec's own AC and mask faults). The ICs are "programmed" (codec DAC, ESP GPIOs), so
// every internal node EMERGES instead of being pinned. We then ask every component if it is in-envelope.
const COMPONENTS = allComponents(netlist);

// the bus is not a stiff rail: it idles +12 V but sags to ~9.4 V under the ~29 mA seal-in load ⇒ source
// impedance ≈ (12.1−9.4)/0.029 ≈ 90 Ω. Drive each bus line through that, from an ideal source.
const BUS_Z = 90;

// solve a scenario → full waveforms (RES). sources = ideal external rails (VBUS/GND); bus = TV20/S bus
// lines, each driven behind BUS_Z; program = IC behavioural state (passed into the device models).
function scenarioRES({ sources = {}, bus = {}, program = {}, switches = {}, T = 4 / 1000, dt = 2e-6 }) {
  const switchState = { ...defaultSwitchState(netlist), ...switches };
  const extra = [];
  const srcs = Object.entries(sources).map(([net, v]) => ({ net, vf: typeof v === 'function' ? v : () => v }));
  for (const [line, v] of Object.entries(bus)) {
    const src = `${line}~bus`;
    srcs.push({ net: src, vf: typeof v === 'function' ? v : () => v });
    extra.push({ type: 'R', a: src, b: line, value: BUS_Z, ref: `busZ${line}` });
  }
  const els = buildElements(netlist, { switchState, program, extra });
  return simulate(els, srcs, gndOf(netlist), T, dt);
}

// ask every component if any pin left its abs-max window at any solved instant (past initial settling);
// keep the worst excursion per pin.
function safetyViolations(RES) {
  const nets = Object.keys(RES.v), len = RES.v[nets[0]].length, worst = new Map();
  const floating = RES.floating || {};
  for (let i = Math.floor(len / 3); i < len; i++) { // skip rail/VMID start-up, keep all transients after
    const vn = {};
    // never assert on a floating node — its DC is undefined (e.g. a high-Z idle bus line). This is the
    // dual of the "don't inject ideal sources" rule: don't trust it.
    for (const n of nets) vn[n] = floating[n] ? NaN : RES.v[n][i];
    for (const c of COMPONENTS)
      for (const x of c.checkSafe(vn)) {
        const exc = Math.max(x.lo - x.v, x.v - x.hi), k = `${x.ref}.${x.pin}`, prev = worst.get(k);
        if (!prev || exc > prev.exc) worst.set(k, { ...x, exc });
      }
  }
  return [...worst.values()];
}
const fmtV = (x) => `${x.ref} pin ${x.pin} (${x.net}) = ${x.v.toFixed(2)} V, outside [${x.lo}, ${x.hi}] — ${x.why}`;

// shared talk scenario: assert PTT at t = 1.5 ms (the make edge), codec DAC biased mid-rail + a tone.
// Deliberately short: it exercises the K1 make transient and the restored V4.1 step handshake.
const TALK = {
  sources: { '/VBUS': 5, '/P1': 0 },
  bus: { '/P2': 12 },
  program: {
    U1: { '/PTT_DRV': (t) => (t < 1.5e-3 ? 0 : 3.3) },
    U3: { out: (t) => 1.65 + 0.4 * Math.sin(2 * Math.PI * 1000 * t) },
  },
  T: 3.5e-3, dt: 2e-6,
};

test('codec talk (TX): K1 make stays within abs-max (B1) and the V4.1 handshake asserts promptly', () => {
  const RES = scenarioRES(TALK);
  // SAFETY INVARIANT (B1) — C14's bus side lives on /TX_OUT: a PTT make (and a door bridge yanking P3
  // to the rail — the sweep below) steps that node, and C14 couples the edge back toward OUTP. R26 +
  // D13 must hold OUTP inside the ES8311 analog abs-max. U3 reports this about ITSELF (limit in Ic).
  const v = safetyViolations(RES).filter((x) => x.ref === 'U3');
  assert.equal(v.length, 0,
    `ES8311 must stay within abs-max during a PTT make — B1: series R26 + D13 between OUTP and C14:\n  ` +
    v.map(fmtV).join('\n  '));

  assert.ok(meanLevel(RES, '/P3', '/P1') > 10,
    `the restored 2.2 k handshake should assert within milliseconds, got ${meanLevel(RES, '/P3', '/P1').toFixed(2)} V`);
});

// Generic gate: sweep the scenario battery and ask every component. B1 is one cell; the bus ring and the
// ±8.8 V RX gong pass — proof the guard is specific (real overstress), not a blanket reject.
test('safety invariants: every component stays within its abs-max across the scenario sweep', () => {
  const gong = (t) => 8.8 * Math.sin(2 * Math.PI * 1000 * t);
  const scenarios = [
    ['talk (PTT make)', scenarioRES(TALK)],
    ['house ring', scenarioRES({ sources: { '/VBUS': 5, '/P1': 0 }, bus: { '/P2': 12, '/P4': 12 }, program: { U3: { out: 1.65 } }, T: 3e-3, dt: 5e-6 })],
    ['RX gong ±8.8 V', scenarioRES({ sources: { '/VBUS': 5, '/P1': 0 }, bus: { '/P2': gong }, program: { U3: { out: 1.65 } }, T: 40 / 1000, dt: 1 / (1000 * 64) })],
    // the new C14 worst case: a door bridge (K2 makes ~38 ms after DOOR_DRV via the Q3 lead delay)
    // yanks P3 to the rail while PTT holds ch2 closed — the step couples through C14 toward OUTP.
    ['door bridge during talk', scenarioRES({ sources: { '/VBUS': 5, '/P1': 0 }, bus: { '/P2': 12 },
      program: { U1: { '/PTT_DRV': 3.3, '/DOOR_DRV': (t) => (t < 1.5e-3 ? 0 : 3.3) }, U3: { out: 1.65 } },
      T: 60e-3, dt: 2e-5 })],
  ];
  const viol = scenarios.flatMap(([n, RES]) => safetyViolations(RES).map((x) => `[${n}] ${fmtV(x)}`));
  assert.equal(viol.length, 0,
    `every component must stay within its datasheet abs-max in all scenarios — ${viol.length} violation(s):\n  ` +
    viol.join('\n  '));
});

// BUS-1: the dual GAQW212GS gates the TX *output* — ch2 (/TX_OUT↔/P3). With K1 open that contact lifts,
// so the permanently-wired codec (ES_OUTP→R26→C14→TALK_BRIDGE→R28→TX_OUT) cannot reach line 3:
// line 3 is high-Z at idle. This is the point of K1's second contact.
test('TX idle isolation: codec audio must not reach line 3 when K1 is open (BUS-1)', () => {
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 }, program: { U1: { '/PTT_DRV': 0 }, U3: { out: { p: codecOut(1), n: codecOut(-1) } } }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.1, `K1 open should keep codec audio off line 3, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

test('talk handshake (K1): energised bridges P2 onto P3 through R28; idle lifts it', () => {
  // K1 closes both halves: P2 → K1-ch1 → TALK_BRIDGE → R28 (2.2 k) → TX_OUT → K1-ch2 → P3.
  const talk = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/PTT_DRV': 3.3 } }, T: 5e-3 }).V;
  assert.ok(talk['/P3'] > 10, `K1 in talk should bring line 3 DC-hot off the P2 supply, got ${talk['/P3']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/PTT_DRV': 0 } } }).V;
  assert.ok(!(idle['/P3'] > 6), `K1 idle should lift line 3 off the handshake, got ${idle['/P3']?.toFixed(2)} V`);
});

test('TX topology: handshake, gate and factory-bridged 200 kΩ precharge match the intended path', () => {
  const C = (ref) => netlist.components.find((c) => c.ref === ref);
  const r28 = C('R28'), c14 = C('C14'), k1 = C('K1');
  const jp3 = C('JP3'), r38 = C('R38'), r39 = C('R39');
  assert.equal(r28.pins['2'], '/TALK_BRIDGE');
  assert.equal(r28.pins['1'], '/TX_OUT');
  assert.equal(c14.pins['2'], '/TALK_BRIDGE');
  assert.equal(k1.pins['8'], '/P2');
  assert.equal(k1.pins['7'], '/TALK_BRIDGE');
  assert.equal(k1.pins['6'], '/TX_OUT');
  assert.equal(k1.pins['5'], '/P3');

  assert.equal(jp3.value, 'TX_PRECHARGE');
  assert.equal(defaultSwitchState(netlist).JP3, true, 'JP3 must be factory bridged');
  assert.equal(jp3.pins['1'], '/P2');
  assert.equal(jp3.pins['2'], '/PRECHG_IN');
  assert.equal(r38.value, '100k');
  assert.equal(r38.pins['1'], '/PRECHG_IN');
  assert.equal(r38.pins['2'], '/PRECHG_MID');
  assert.equal(r39.value, '100k');
  assert.equal(r39.pins['2'], '/PRECHG_MID');
  assert.equal(r39.pins['1'], '/TALK_BRIDGE');
});

// K6 removes raw P4, including its gong, from the latched K5/P2 handshake source. The restored R28
// path therefore passes the DC talk pedestal without needing a voice-band shunt on the codec output.
test('K6 isolation: a raw-P4 gong stays off P3 while the restored handshake DC passes', () => {
  const rawP4 = (t) => 12 + 8.8 * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': rawP4 },
    program: { U1: { '/P4_ISO': 3.3, '/PTT_DRV': 3.3 }, U3: { out: 1.65 } }, T: 40e-3, dt: 2e-5 });
  assert.ok(meanLevel(RES, '/P3', '/P1') > 10,
    `the P2 pedestal must still assert talk, got ${meanLevel(RES, '/P3', '/P1').toFixed(2)} V`);
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.2,
    `opening K6 must keep the raw-P4 gong off P3, got ${(swingPP(RES, '/P3', '/P1') * 1000).toFixed(0)} mVpp`);
});

// Software TX must not accidentally transmit the passive handset microphone. The relevant state is
// K1 active with manual SW4 released: LS1 can still feed P4 through the gong capacitor and, while K5
// is latched, P2 through the seal-in. K6 must break that path before K1 transmits. Exercise both K3
// states because K3 independently controls whether the local transducer is connected to raw P4.
const softwareTxSwing = ({ mute, speakerTone, codecTone }) => {
  const switches = { ...defaultSwitchState(netlist), SW4: false };
  const tone = (t) => 1.65 + 0.4 * Math.sin(2 * Math.PI * 1000 * t); // 0.8 Vpp, centred like OUTP
  const els = buildElements(netlist, {
    switchState: switches,
    extra: [{ type: 'R', a: '/P2~bus', b: '/P2', value: BUS_Z, ref: 'busZ/P2' }],
    program: {
      U1: { '/PTT_DRV': 3.3, '/MUTE_DRV': mute ? 3.3 : 0, '/P4_ISO': 3.3 },
      U3: { out: codecTone ? tone : 1.65 },
    },
  });
  const dt = 20e-6;
  const run = (sources, T, seed, observe = false) => {
    const sim = createStepper(
      els,
      Object.entries(sources).map(([net, vf]) => ({ net, vf: typeof vf === 'function' ? vf : () => vf })),
      gndOf(netlist),
      dt,
      seed,
    );
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < T; t += dt) {
      sim.step(t);
      if (observe && t >= T / 2) {
        const p3 = sim.vn[sim.ni['/P3']] ?? 0;
        lo = Math.min(lo, p3);
        hi = Math.max(hi, p3);
      }
    }
    return { state: sim.extractState(), swing: observe ? hi - lo : 0 };
  };

  // Pull K5 in from a real Türruf, then remove the P4 source: P2 must seal the call in while the
  // measurement drives LS1 (/P5↔/P1). This preserves the exact unintended path under test.
  const latched = run({ '/VBUS': 5, '/P1': 0, '/P2~bus': 12, '/P4': 12 }, 0.02).state;
  assert.ok(latched.relays.K5, 'precondition: the software-TX isolation scenario must have K5 latched');
  assert.ok(latched.ssrs.K6, 'precondition: K5 must complete the K6 LED return and open isolation');
  const speaker = speakerTone ? (t) => 0.4 * Math.sin(2 * Math.PI * 1000 * t) : undefined;
  const sources = { '/VBUS': 5, '/P1': 0, '/P2~bus': 12 };
  if (speaker) sources['/P5'] = speaker;
  // Sixty periods of the 1 kHz stimulus are ample for a stable peak-to-peak ratio; observe the
  // second half (30 complete periods) without spending 600 periods on an unchanged steady state.
  return run(sources, 60e-3, latched, true).swing;
};

test('software TX isolation: the passive LS1 microphone stays small relative to codec TX', () => {
  // Drive LS1 with the same deliberately severe 0.8 Vpp used for the codec reference. With K6 open,
  // the passive transducer remains on raw P4 while codec TX uses the internal P2 handshake path.
  const maxLeakageRatio = 0.15;
  for (const mute of [false, true]) {
    const leaked = softwareTxSwing({ mute, speakerTone: true, codecTone: false });
    const wanted = softwareTxSwing({ mute, speakerTone: false, codecTone: true });
    assert.ok(wanted > 0.001, `codec TX reference must reach P3 with K3 ${mute ? 'open' : 'closed'}, got ${wanted.toFixed(4)} Vpp`);
    assert.ok(leaked < wanted * maxLeakageRatio,
      `LS1 leakage with K3 ${mute ? 'open' : 'closed'} must stay below 15% of codec TX, ` +
      `got ${(leaked * 1000).toFixed(2)} mVpp vs ${(wanted * 1000).toFixed(2)} mVpp`);
  }
});

// TX is deliberately session-INDEPENDENT (gated-TX requirement: the board may assert talk whenever it
// chooses, even with no incoming Türruf). The handshake is sourced from P2 — which the bus keeps
// energised at all times — not from line 4, so K1 energised drives line 3 with line 4 cold. Policy for
// *when* to talk lives in firmware, not this hardware gate.
test('TX is session-independent: K1 energised drives line 3 from P2 with line 4 cold (no Türruf)', () => {
  const { V } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 0 },
    program: { U1: { '/PTT_DRV': 3.3 } },
    T: 5e-3, // static K1 handshake; session timing is deliberately absent from this requirement
  });
  assert.ok(V['/P3'] > 10, `P2-sourced handshake should reach line 3 with no session, got ${V['/P3']?.toFixed(2)} V`);
});

// The session itself is the passive K5 latch: a Türruf energises the
// coil (line 4 ↔ P1) and its NO contact closes K1_COM onto line 4. (The seal-in from P2 after line 4
// drops is dynamic — exercised by the engine's relay latch, not this steady-state DC check.)
test('session latch: a Türruf pulls in K5 (its contact closes K1_COM onto line 4)', () => {
  const hot = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } }).V;
  assert.ok(near(hot['/SEAL_IN'], 12, 1.0), `a Türruf should pull the latch in (COM→line 4), got ${hot['/SEAL_IN']?.toFixed(2)} V`);

  const { V: idle, floating } = runDC(netlist, { sources: { '/P1': 0, '/P4': 0 } });
  assert.ok(!near(idle['/SEAL_IN'], 12, 1.0) || floating['/SEAL_IN'],
    `idle line 4 should leave the latch open, got ${idle['/SEAL_IN']?.toFixed(2)} V (floating=${floating['/SEAL_IN']})`);
});

// The session is a P2 seal-in (bench: captures/runs/our-ring-door-open/notes.md, pending a dedicated handset
// confirmation — see TODO). A Türruf *pulse* on line 4 pulls K5 in; because P2 is *always*
// energised it then seals the coil in (`P2 → S1 NC → K1_COM → the closed NO contact → line 4 → coil`)
// and self-holds. **Dropping line 4 does NOT release it** — P2 holds it. The session ends via P2: the
// ~60 s timeout drives P2 low. A door-open also ends a session — but only the *handset's* button does
// it directly: S1 is a DPDT break-before-make that lifts P2 off K1_COM, dropping the latch (asserted in
// the SW3 / DOOR-4 tests below). The board reproduces that break with K4 (an NC SSR in the seal-in)
// plus the Q1/RC make-delay on K2 — a hardware break-before-make (DOOR-4 test below).
test('session seal-in: dropping line 4 does NOT release K5 (P2 holds it); driving P2 low ends it', () => {
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const gnd = gndOf(netlist), dt = 20e-6;
  const settle = (srcs, seed) => {
    const sim = createStepper(els, srcs.map(([net, v]) => ({ net, vf: () => v })), gnd, dt, seed);
    for (let t = 0; t < 0.01; t += dt) sim.step(t);
    return sim.extractState();
  };
  // ring: line 4 pulsed hot with P2 energised -> pull in
  const latched = settle([['/P2', 12], ['/P4', 12], ['/P1', 0]]);
  assert.ok(latched.relays.K5, 'a Türruf should pull K5 in');
  // line 4 released (floats), P2 still energised: the latch self-holds — dropping line 4 does NOT release
  const held = settle([['/P2', 12], ['/P1', 0]], latched);
  assert.ok(held.relays.K5, 'dropping line 4 must NOT release the latch — P2 seals it in');
  // session end: P2 driven low (the ~60 s timeout) releases it
  const released = settle([['/P2', 0], ['/P1', 0]], latched);
  assert.ok(!released.relays.K5, 'driving P2 low (timeout) must release the latch');
});

// ── Door-open vs the WF26 latch (REQUIREMENTS DOOR-4 / MODE-3) ──────────────────────────────────────
// The handset's door button S1 is a DPDT break-before-make: pressing it lifts line 2 off the latch's
// seal-in node (K1_COM) *and* bridges P2↔P3, so K5 drops as the opener fires. In the sim the coil
// node (P4) is loaded by C19 (22 µF, via the closed K3) so it decays on an ~RC of a few tens of ms
// — far slower than the bench ~6 ms break-before-make (a model artifact) — so these settle ~100 ms and
// assert the END state, not the timing.
const latchSettle = (els, srcs, T, seed) => {
  const sim = createStepper(els, srcs.map(([net, v]) => ({ net, vf: () => v })), gndOf(netlist), 20e-6, seed);
  for (let t = 0; t < T; t += 20e-6) sim.step(t);
  return sim.extractState();
};

test('SW3 (handset door button) releases the K5 latch — the break-before-make reference', () => {
  const ds = defaultSwitchState(netlist);
  const elsReleased = buildElements(netlist, { switchState: ds });
  const elsPressed = buildElements(netlist, { switchState: { ...ds, SW3: true } });
  const latched = latchSettle(elsReleased, [['/P2', 12], ['/P4', 12], ['/P1', 0]], 0.01);
  assert.ok(latched.relays.K5, 'a Türruf should pull K5 in');
  const held = latchSettle(elsReleased, [['/P2', 12], ['/P1', 0]], 0.01, latched);
  assert.ok(held.relays.K5, 'dropping line 4 must not release the latch (P2 seal-in)');
  // press S1: it breaks P2→K1_COM (seal-in) and bridges P2↔P3 — the latch must drop, the door must fire
  const pressed = latchSettle(elsPressed, [['/P2', 12], ['/P1', 0]], 0.1, held);
  assert.ok(!pressed.relays.K5, 'pressing S1 must release K5 (it lifts P2 off the seal-in)');
  assert.ok(near(pressed.vn['/P3'], 12), `S1 press must bridge P2→P3 (door), got ${pressed.vn['/P3']?.toFixed(2)} V`);
});

test('DOOR-4: a board door-open (DOOR_DRV) releases K5 like S1', () => {
  // K4 (the NC seal-in-break SSR, driven off DOOR_DRV) opens the P2→K1_COM seal-in as the opener fires,
  // so the latch drops — DOOR-4 met. The break-before-make *lead* (K4 immediate, K2 delayed ~20 ms by
  // the Q1/R17/C18 RC) is NOT shown here: the sim's coil decay is RC-limited by C1's 22 µF (~60 ms) vs
  // the real ~6 ms, so the modelled latch drop trails K2's P3 bridge. We assert the END state — latch
  // released + door fired — which is what DOOR-4 requires.
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const latched = latchSettle(els, [['/P2', 12], ['/P4', 12], ['/P1', 0]], 0.01);
  assert.ok(latched.relays.K5, 'a Türruf should pull K5 in');
  const held = latchSettle(els, [['/P2', 12], ['/P1', 0]], 0.01, latched);
  assert.ok(held.relays.K5, 'dropping line 4 must not release the latch (P2 seal-in)');
  // the board asserts the door GPIO — drive /DOOR_DRV through the ESP (program), not as an ideal source
  const elsOpen = buildElements(netlist, { switchState: defaultSwitchState(netlist), program: { U1: { '/DOOR_DRV': 3.3 } } });
  const opened = latchSettle(elsOpen, [['/P2', 12], ['/P1', 0], ['/VBUS', 5]], 0.12, held);
  assert.ok(!opened.relays.K5, 'DOOR-4: a board door-open must release the latch (K4 breaks the seal-in)');
  assert.ok(near(opened.vn['/P3'], 12), `door-open must fire the opener (P2→P3), got ${opened.vn['/P3']?.toFixed(2)} V`);
});

const doorDrivePhase = ({ drive, T, seed, observe = false, step = 20e-6 }) => {
  const els = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/DOOR_DRV': drive ? 3.3 : 0 } },
  });
  const sim = createStepper(
    els,
    [['/VBUS', 5], ['/P1', 0], ['/P2', 12]].map(([net, v]) => ({ net, vf: () => v })),
    gndOf(netlist),
    step,
    seed,
  );
  let makeBeforeBreak = false;
  for (let t = 0; t < T; t += step) {
    sim.step(t);
    if (observe) {
      const { ssrs } = sim.extractState();
      // K2 energized = door bridge made; K4 not energized = NC seal-in contact closed.
      makeBeforeBreak ||= Boolean(ssrs.K2) && !Boolean(ssrs.K4);
    }
  }
  return { state: sim.extractState(), makeBeforeBreak };
};

const retriggerDoorAfter = (gap) => {
  const first = doorDrivePhase({ drive: true, T: 0.1 });
  // Nothing switches during a long released gap; C18 only discharges on its slow RC timescale.
  const released = doorDrivePhase({ drive: false, T: gap, seed: first.state, step: gap > 0.1 ? 1e-3 : 20e-6 });
  return {
    releaseGate: released.state.vn['/DELAY_GATE'],
    retriggered: doorDrivePhase({ drive: true, T: 0.08, seed: released.state, observe: true }),
  };
};

test('door retrigger: a short off-time leaves C18/Q3 partially armed', () => {
  const { releaseGate } = retriggerDoorAfter(0.01);
  assert.ok(releaseGate > 0.65, `10 ms off-time should leave DELAY_GATE above Q3 Vth,min, got ${releaseGate.toFixed(2)} V`);
});

test('door retrigger: 0.5 s minimum off-time restores break-before-make', () => {
  const { releaseGate, retriggered } = retriggerDoorAfter(0.5);
  assert.ok(releaseGate < 0.1, `500 ms off-time should discharge DELAY_GATE, got ${releaseGate.toFixed(2)} V`);
  assert.equal(retriggered.makeBeforeBreak, false, '500 ms off-time must fully re-arm the K4-before-K2 sequence');
});

// ── Composed door transitions — the hardware facts behind the firmware door coordinator (TODO.md):
// nothing in hardware serializes door, isolation and TX, so these pin down what each overlap does. ──

test('composed door + isolation: door with P4_ISO held re-pulls K5 from the hot line (the chatter hazard)', () => {
  const dt = 20e-6;
  const srcList = [['/VBUS', 5], ['/P1', 0], ['/P2', 12], ['/P4', 12]]; // the gong is still hot
  const srcs = () => srcList.map(([net, v]) => ({ net, vf: () => v }));
  const countK5Transitions = (els, seed, T) => {
    const sim = createStepper(els, srcs(), gndOf(netlist), dt, seed);
    let transitions = 0;
    let lastK5 = true;
    for (let t = 0; t < T; t += dt) {
      sim.step(t);
      const k5 = Boolean(sim.extractState().relays.K5);
      if (k5 !== lastK5) transitions++;
      lastK5 = k5;
    }
    return { transitions, end: sim.extractState() };
  };

  const elsIso = buildElements(netlist, { switchState: defaultSwitchState(netlist), program: { U1: { '/P4_ISO': 3.3 } } });
  const iso = latchSettle(elsIso, srcList, 0.04);
  assert.ok(iso.relays.K5, 'precondition: the hot Türruf must latch K5');
  assert.ok(iso.ssrs.K6, 'precondition: confirmed K5 must open isolation');

  // door while isolation is held: K4 breaks the seal, K5 drops, K6 recloses onto the hot line,
  // K5 re-pulls, its auxiliary contact re-opens K6 — alternation until something yields. This is why
  // the coordinator must clear P4_ISO and wait out K6's close time before DOOR_DRV rises.
  const elsDoorIso = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/P4_ISO': 3.3, '/DOOR_DRV': 3.3 } },
  });
  const hazard = countK5Transitions(elsDoorIso, iso, 0.3);
  assert.ok(hazard.transitions >= 2,
    `door + held isolation over a hot line must chatter K5 (drop, re-pull, …), saw ${hazard.transitions} transitions`);

  // the coordinator's sequence: clear P4_ISO first — K6 recloses and the hot line holds K5 steadily
  // through the door pulse; no K5/K6 alternation, and the opener still fires.
  const elsDoorClean = buildElements(netlist, {
    switchState: defaultSwitchState(netlist),
    program: { U1: { '/DOOR_DRV': 3.3 } },
  });
  const clean = countK5Transitions(elsDoorClean, iso, 0.3);
  assert.equal(clean.transitions, 0, 'with P4_ISO cleared first, the hot line must hold K5 steadily (no chatter)');
  assert.ok(near(clean.end.vn['/P3'], 12), `the door must still fire, got P3=${clean.end.vn['/P3']?.toFixed(2)} V`);
});

test('composed K1 + door: the door bridge replaces the 2.2 k handshake signature on line 3', () => {
  // Probe line 3 the way the TV20/S sees it: a 1 V tone behind 10 k. Against the K1 talk handshake
  // (R28 = 2.2 k into the low-Z bus) the probe survives at P3; against K2's door short it collapses —
  // the door signature masks talk, and nothing in hardware prevents the overlap (BUS-2 b composition).
  const probe = { type: 'R', a: '/P3~probe', b: '/P3', value: 10000, ref: 'probeZ/P3' };
  const tone = (t) => 12 + Math.sin(2 * Math.PI * 1000 * t);
  const measure = (program) => {
    const { RES, V } = runDC(netlist, {
      sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P3~probe': tone },
      program: { U1: program },
      extra: [probe],
      T: 0.1, dt: 1 / (1000 * 64), // second half of the run is past K2's ~38 ms make delay
    });
    return { swing: swingPP(RES, '/P3', '/P1'), V };
  };

  const talk = measure({ '/PTT_DRV': 3.3 });
  const overlap = measure({ '/PTT_DRV': 3.3, '/DOOR_DRV': 3.3 });
  assert.ok(talk.swing > 0.05,
    `the probe must survive against the 2.2 k handshake, got ${talk.swing.toFixed(4)} Vpp`);
  assert.ok(overlap.swing < talk.swing / 5,
    `the door short must collapse the line-3 signature: talk ${talk.swing.toFixed(4)} vs overlap ${overlap.swing.toFixed(4)} Vpp`);
  assert.ok(near(overlap.V['/P3'], 12, 0.5),
    `the door must dominate the composed state (P3 pinned to P2), got ${overlap.V['/P3']?.toFixed(2)} V`);
});

test('composed rapid door repeat with a mid-gap ring: re-arm behaviour is unchanged by a fresh session', () => {
  // The pure retrigger tests above prove the C18/Q3 re-arm floor without a session. A ring can land
  // in the off-time and re-latch K5; the re-arm state and the second pulse's outcome must not change.
  const doorPhase = ({ drive, ring = false, T, seed, observe = false, dt = 20e-6 }) => {
    const els = buildElements(netlist, {
      switchState: defaultSwitchState(netlist),
      program: { U1: { '/DOOR_DRV': drive ? 3.3 : 0 } },
    });
    const srcs = [
      { net: '/VBUS', vf: () => 5 },
      { net: '/P1', vf: () => 0 },
      { net: '/P2', vf: () => 12 },
    ];
    if (ring) srcs.push({ net: '/P4', vf: (t) => (t < 8e-3 ? 12 : 0) }); // a Türruf pulse early in the gap
    const sim = createStepper(els, srcs, gndOf(netlist), dt, seed);
    let makeBeforeBreak = false;
    for (let t = 0; t < T; t += dt) {
      sim.step(t);
      if (observe) {
        const { ssrs } = sim.extractState();
        makeBeforeBreak ||= Boolean(ssrs.K2) && !ssrs.K4;
      }
    }
    return { state: sim.extractState(), makeBeforeBreak };
  };

  for (const [gap, armed] of [[0.01, true], [0.5, false]]) {
    const first = doorPhase({ drive: true, T: 0.1 });
    assert.ok(!first.state.relays.K5, 'no session yet: the first pulse fires without K5');
    // The long gap contains only an 8 ms ring plus slow C18 discharge. A 0.5 ms step still resolves
    // the ring and K5's 3 ms operate time while avoiding 25,000 unchanged fine-grained solves.
    const idleRing = doorPhase({
      drive: false, ring: true, T: gap, seed: first.state, dt: gap > 0.1 ? 0.5e-3 : 20e-6,
    });
    assert.ok(idleRing.state.relays.K5, `a ring in the ${gap * 1e3} ms gap must latch a fresh session`);
    const gate = idleRing.state.vn['/DELAY_GATE'];
    if (armed) {
      assert.ok(gate > 0.65, `10 ms off-time must leave DELAY_GATE armed, session or not, got ${gate.toFixed(2)} V`);
    } else {
      assert.ok(gate < 0.1, `500 ms off-time must discharge DELAY_GATE, session or not, got ${gate.toFixed(2)} V`);
    }
    const second = doorPhase({ drive: true, T: 0.12, seed: idleRing.state, observe: true });
    if (!armed) {
      assert.equal(second.makeBeforeBreak, false,
        'the 500 ms floor must preserve K4-before-K2 with a freshly latched session');
    }
    assert.ok(!second.state.relays.K5, `the ${gap * 1e3} ms-gap second pulse must still release the fresh session`);
    assert.ok(near(second.state.vn['/P3'], 12),
      `the second pulse must still fire the opener, got ${second.state.vn['/P3']?.toFixed(2)} V`);
  }
});

// ── Door-open max-on-time watchdog (Q3 unit 2 + R25/C20/D11) ─────────────────────────────────────
// The door opener is the K2 bridge (P2↔P3). If the ESP hangs with /DOOR_DRV latched high the door
// would stay "pressed", so a hardware one-shot limits it: /DOOR_DRV charges /WD_GATE through R25
// (10 M) · C20 (2.2 µF) (τ ≈ 22 s; ~8.4 s nominal model trip); once /WD_GATE passes the FET threshold, Q3 unit 2 pulls /DELAY_GATE
// low, turning off Q3 unit 1 (K2's break-before-make low-side switch) → K2 opens → the bridge drops.
// R25 is sized so even the worst (cold / min-Vth / cap-derated) corner trips well after the 1.75 s
// firmware pulse, so a real door-open is never cut short (DOOR-5).

test('door watchdog: an armed /WD_GATE drops the K2 bridge even with /DOOR_DRV held high', () => {
  // drive /WD_GATE high directly to stand in for the charged RC — tests the mechanism, not the timing
  const armed = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/WD_GATE': 3.3 }, program: { U1: { '/DOOR_DRV': 3.3 } } }).V;
  assert.ok(!near(armed['/P3'], 12, 2.0), `an armed watchdog must drop the door bridge, got P3=${armed['/P3']?.toFixed(2)} V`);

  // with /WD_GATE held low (RC not yet charged) the same drive keeps the door open
  const open = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/WD_GATE': 0 }, program: { U1: { '/DOOR_DRV': 3.3 } }, T: 0.1 }).V;
  assert.ok(near(open['/P3'], 12), `un-armed, the door must stay open, got P3=${open['/P3']?.toFixed(2)} V`);
});

test('door watchdog timing: /DOOR_DRV stuck high opens the door, then self-releases after the RC timeout', () => {
  // /DOOR_DRV is the ESP holding the door GPIO high — inject it through the ESP model (program)
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist), program: { U1: { '/DOOR_DRV': 3.3 } } });
  const dt = 2e-3;
  const sim = createStepper(els,
    [['/VBUS', 5], ['/P1', 0], ['/P2', 12]].map(([net, v]) => ({ net, vf: () => v })),
    gndOf(netlist), dt);
  // door fires and is still bridged at the end of the full 1.75 s firmware pulse (the RC is nowhere
  // near threshold). This guards the R25 value: too small an R times out early and truncates the pulse.
  for (let t = 0; t < 1.75; t += dt) sim.step(t);
  const open = sim.extractState();
  assert.ok(near(open.vn['/P3'], 12), `door must still be bridged at the end of the 1.75 s pulse (not truncated), got P3=${open.vn['/P3']?.toFixed(2)} V`);
  // run past the current revision's ~8.4 s nominal model timeout: the watchdog must drop the bridge
  // though /DOOR_DRV is still asserted
  for (let t = 1.75; t < 16.0; t += dt) sim.step(t);
  const released = sim.extractState();
  assert.ok(!near(released.vn['/P3'], 12, 2.0), `watchdog should release the door by 16 s, got P3=${released.vn['/P3']?.toFixed(2)} V`);
});

// ── power & protection front-end ──

test('J1 power input regulates +5V and +3V3', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 } });
  assert.ok(near(V['+3V3'], 3.3, 0.1),
    `J1: +3V3 should regulate to ~3.3 V, got ${V['+3V3']?.toFixed(3)}`);
  assert.ok(V['+5V'] > 4.6 && V['+5V'] < 5.05,
    `J1: +5V should sit just below the input, got ${V['+5V']?.toFixed(3)}`);
});

test('post-fuse supply monitor scales +5V safely into GPIO5 ADC1', () => {
  const byRef = Object.fromEntries(netlist.components.map((component) => [component.ref, component]));

  assert.equal(byRef.R40.value, '100k');
  assert.deepEqual(byRef.R40.pins, { '1': '+5V', '2': '/VBUS_F_ADC' });
  assert.equal(byRef.R41.value, '10k');
  assert.deepEqual(byRef.R41.pins, { '1': '/VBUS_F_ADC', '2': 'GND' });
  assert.equal(byRef.C25.value, '100nF');
  assert.deepEqual(byRef.C25.pins, { '1': '/VBUS_F_ADC', '2': 'GND' });
  assert.equal(byRef.U1.pins['5'], '/VBUS_F_ADC');
  assert.equal(byRef.U1.pinfn['5'], 'IO5_5');

  const powered = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 } }).V;
  assert.ok(near(powered['/VBUS_F_ADC'], powered['+5V'] / 11, 0.01),
    `VBUS_F_ADC should be +5V/11, got ${powered['/VBUS_F_ADC']?.toFixed(3)} V from +5V=${powered['+5V']?.toFixed(3)} V`);

  const unpowered = runDC(netlist, { sources: {} }).V;
  assert.ok(Math.abs(unpowered['/VBUS_F_ADC']) < 0.05,
    `R41 should hold VBUS_F_ADC near 0 V unpowered, got ${unpowered['/VBUS_F_ADC']?.toFixed(3)} V`);

  const clamped = runDC(netlist, { sources: { '+5V': 9.2, '/P1': 0 } }).V;
  assert.ok(near(clamped['/VBUS_F_ADC'], 9.2 / 11, 0.02),
    `VBUS_F_ADC should remain about 0.84 V at D10's maximum clamp voltage, got ${clamped['/VBUS_F_ADC']?.toFixed(3)} V`);
});

test('unpowered board: rails rest at 0, no phantom voltage', () => {
  const { V, floating } = runDC(netlist, { sources: {} });
  // the IC supply loads (ESP32/codec) tie +3V3 toward GND, so unpowered the rail rests at a hard 0
  assert.ok(!floating['+3V3'], '+3V3 should be tied to GND by the IC loads, not floating');
  assert.ok(Math.abs(V['+3V3']) < 0.1, `+3V3 should be ~0 unpowered, got ${V['+3V3']?.toFixed(3)}`);
});

test('ESD array (D5): a surge on the USB data line is clamped to ~VBUS, not passed to the ESP', () => {
  // a 500 V transient through a 330 Ω source impedance (the IEC ESD network) onto D−
  const { V } = runDC(netlist, {
    sources: { '+5V': 5, '/SURGE': 500 },
    extra: [{ type: 'R', a: '/SURGE', b: '/USB_DN', value: 330 }],
  });
  assert.ok(V['/USB_ESP_DN'] < 8, `D5 should clamp the ESP-side line near VBUS, got ${V['/USB_ESP_DN']?.toFixed(2)} V`);
  assert.ok(V['/USB_ESP_DN'] > 4, `the steering diode should clamp to ~VBUS+Vf, got ${V['/USB_ESP_DN']?.toFixed(2)} V`);
});

test('D4 blocks back-feed and a reversed J1 input', () => {
  const backFeed = runDC(netlist, {
    sources: { '+5V': 5, '/VBUS': 0, '/P1': 0 },
  }).V;
  assert.ok(backFeed['/VBUS'] < 0.5,
    `fused +5V must not feed back out through J1, got ${backFeed['/VBUS']?.toFixed(2)} V`);

  const reversed = runDC(netlist, { sources: { '/VBUS': -5, '/P1': 0 } }).V;
  assert.ok(Math.abs(reversed['+5V']) < 0.1,
    `a reversed J1 input must leave +5V off, got ${reversed['+5V']?.toFixed(2)} V`);
});
