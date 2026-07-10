// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
//
// Architecture under test (see DESIGN.md):
//  - K1/K2/K3 are PhotoMOS SSRs driven by a GPIO through a 300 Ω LED resistor on /PTT_DRV /DOOR_DRV /MUTE_DRV.
//    K1 (dual NO) talks: ch1 sources /P2 into the Ra/Cf/Rb low-pass (/TALK_BRIDGE → R34 → /HS_FILT →
//    R35 → /TX_OUT — the gong-stripped 2.2 k talk handshake; Cf = C25∥C26 returns via JP1), ch2 gates
//    /TX_OUT↔/P3; K2 (NO) bridges /P2↔/P3 (door opener); K3 (NC) bridges /P4↔/CHIME_C1 (chime) —
//    closed at rest, opened to suppress.
//  - The embedded WF26 core (K5 latch + S1/S2 + C1) is passive and works unpowered (SAFE-4).
//  - Audio is transformer-less: RX taps /P2 through C16 to the ES8311 ADC (MICP/MICN); TX runs the
//    codec DAC (OUTP) through R26 → C14 → /TX_OUT, downstream of the filter.
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
  // S2 connects /R29_BRIDGE↔/P3; R29 (2.2 k) ties /P4↔/R29_BRIDGE. So a held line 4
  // reaches line 3 through R1 when S2 is pressed — the handset's own DC talk handshake.
  const { V } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { SW4: true } });
  assert.ok(near(V['/P3'], 12, 1.0), `S2 pressed should bring P3 up toward line 4, got ${V['/P3']?.toFixed(3)}`);

  const { V: off } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { SW4: false } });
  assert.ok(!near(off['/P3'], 12, 1.0), `S2 released should leave P3 clear of line 4, got ${off['/P3']?.toFixed(3)}`);
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
// passes line 4 → /CHIME_C1; C19 (22 µF) couples the AC to /P5/LS1 and blocks the DC.
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
// pulled to +3V3 (10 kΩ) and read by the ESP, so a hot line pulls the GPIO low. Needs board power.

test('Türruf detection: a hot line 4 pulls OC1_OUT low; an idle line stays high', () => {
  const hot = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 12 } }).V;
  assert.ok(hot['/OC1_OUT'] < 1.0, `a ringing line 4 should pull OC1_OUT low, got ${hot['/OC1_OUT']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 0 } }).V;
  assert.ok(idle['/OC1_OUT'] > 3.0, `an idle line 4 should leave OC1_OUT high (~3V3), got ${idle['/OC1_OUT']?.toFixed(2)} V`);
});

test('Etagenruf detection: a hot line 5 pulls OC2_OUT low; D9 blocks a reverse-polarity false trigger', () => {
  const hot = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': 12 } }).V;
  assert.ok(hot['/OC2_OUT'] < 1.0, `a ringing line 5 should pull OC2_OUT low, got ${hot['/OC2_OUT']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': 0 } }).V;
  assert.ok(idle['/OC2_OUT'] > 3.0, `an idle line 5 should leave OC2_OUT high, got ${idle['/OC2_OUT']?.toFixed(2)} V`);

  // reverse voltage on line 5: D9 (anti-parallel to the LED) shunts it, so the LED never lights
  const rev = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': -12 } }).V;
  assert.ok(rev['/OC2_OUT'] > 3.0, `reverse polarity must not trigger OC2 (LED protected by D9), got ${rev['/OC2_OUT']?.toFixed(2)} V`);
});

// ── actuators (PhotoMOS SSRs, energised via /PTT_DRV /DOOR_DRV /MUTE_DRV through the 300 Ω LED resistor) ──

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
// ahead of K3). Energising K3 opens line 4 → /CHIME_C1, silencing the chime while detection survives.
const gong = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * 1000 * t); // incoming Türruf: 12 V DC + gong tone

test('chime suppress: K3 idle passes the gong to the speaker AND OC1 still detects it', () => {
  const { V, RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': gong }, ...AC }); // MUTE_DRV unset → K3 idle (NC closed)
  assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) > 1.0,
    `K3 idle should let the gong reach LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  assert.ok(V['/OC1_OUT'] < 1.0, `OC1 should detect the ring, got ${V['/OC1_OUT']?.toFixed(2)} V`);
});

test('chime suppress: K3 energised silences the speaker but OC1 keeps detecting', () => {
  const { V, RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': gong }, program: { U1: { '/MUTE_DRV': 3.3 } }, ...AC }); // K3 opened
  assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) < 0.5,
    `K3 energised should silence the chime at LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  assert.ok(V['/OC1_OUT'] < 1.0, `detection must survive suppression (OC1 on line 4, ahead of K3), got ${V['/OC1_OUT']?.toFixed(2)} V`);
});

test('chime suppress fail-safe: line 4 stays bridged to C1 when the ESP is unpowered (K3 NC closed)', () => {
  // no VBUS → the ESP can never open K3, so the gong path (line 4 → /CHIME_C1) must stay made
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } });
  assert.ok(near(V['/CHIME_C1'], 12), `unpowered, K3 NC must bridge line 4 → /CHIME_C1, got ${V['/CHIME_C1']?.toFixed(2)} V`);
});

const chimePhase = ({ mute, sources, T, seed, observe = false, step = 20e-6, jp2 = true }) => {
    const switchState = { ...defaultSwitchState(netlist), JP2: jp2 };
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

const trappedChimeCharge = ({ jp2 = true } = {}) => {
  // Charge the gong coupling capacitors from a real ring with K3 closed, then open K3 while the
  // ring is still present. Ending the session with P2 low drops K5 but leaves CHIME_C1 isolated and
  // charged. Reclosing the NC contact later must not turn that stored charge into another pull-in.
  const ringing = chimePhase({ mute: false, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }, T: 0.02, jp2 });
  return chimePhase({ mute: true, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }, T: 0.005, seed: ringing.state, jp2 }).state;
};

const endAndRecloseChime = ({ charged, wait, jp2 = true }) => {
  const ended = chimePhase({ mute: true, sources: { '/VBUS': 5, '/P1': 0, '/P2': 0 }, T: wait, step: wait > 0.1 ? 5e-3 : 20e-6, seed: charged, jp2 });
  assert.equal(ended.state.relays.K5, false, 'the original ring/session must be over before the reclose check');
  return chimePhase({ mute: false, sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, T: 0.05, seed: ended.state, observe: true, jp2 });
};

test('chime suppress transition: immediate K3 reclose cannot accumulate enough K5 pickup force', () => {
  const reclosed = endAndRecloseChime({ charged: trappedChimeCharge(), wait: 0.02 });
  assert.equal(reclosed.relatched, false, 'the decaying C1 reclose pulse must not accumulate enough coil force to operate K5');
  assert.ok(reclosed.peakP4 > 9.6, `expected a K5-operate-level P4 pulse, got ${reclosed.peakP4.toFixed(2)} V`);
});

test('chime suppress transition: JP2 cut retains charge but still cannot re-latch K5', () => {
  const reclosed = endAndRecloseChime({ charged: trappedChimeCharge({ jp2: false }), wait: 12, jp2: false });
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
  assert.ok(reclosed.peakP4 < 1.5, `R36 should substantially bleed CHIME_C1 by 12 s, got ${reclosed.peakP4.toFixed(2)} V`);
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
  // +3V3 (DVDD/PVDD) via U2, and AVDD via the LP5907 (+5V → U4 → AU_3V3 → FB1 → AVDD, FB1 a DC short)
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
    // never assert on a floating node — its DC is undefined (e.g. the anti-series gong-cap midpoint, or a
    // high-Z idle bus line). This is the dual of the "don't inject ideal sources" rule: don't trust them.
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
// Deliberately SHORT — it exercises the K1 make transient (safety). The handshake DC is a RAMP now
// (Cf charges through Ra; τ ≈ 55 ms in the lightly-loaded sim), so its assert is checked with a
// long-T run below, not in this window.
const TALK = {
  sources: { '/VBUS': 5, '/P1': 0 },
  bus: { '/P2': 12 },
  program: {
    U1: { '/PTT_DRV': (t) => (t < 1.5e-3 ? 0 : 3.3) },
    U3: { out: (t) => 1.65 + 0.4 * Math.sin(2 * Math.PI * 1000 * t) },
  },
  T: 3.5e-3, dt: 2e-6,
};

test('codec talk (TX): K1 make stays within abs-max (B1); the handshake ramps, then asserts', () => {
  const RES = scenarioRES(TALK);
  // SAFETY INVARIANT (B1) — C14's bus side lives on /TX_OUT: a PTT make (and a door bridge yanking P3
  // to the rail — the sweep below) steps that node, and C14 couples the edge back toward OUTP. R26 +
  // D13 must hold OUTP inside the ES8311 analog abs-max. U3 reports this about ITSELF (limit in Ic).
  const v = safetyViolations(RES).filter((x) => x.ref === 'U3');
  assert.equal(v.length, 0,
    `ES8311 must stay within abs-max during a PTT make — B1: series R26 + D13 between OUTP and C14:\n  ` +
    v.map(fmtV).join('\n  '));

  // FUNCTION, part 1 — right after the make, line 3 is still COLD: the filter ramps instead of
  // stepping (this is the gong-free property's flip side; a step here would mean Cf is disconnected).
  assert.ok(meanLevel(RES, '/P3', '/P1') < 3,
    `line 3 should still be ramping just after the make, got ${meanLevel(RES, '/P3', '/P1').toFixed(2)} V`);

  // FUNCTION, part 2 — once Cf settles (~3τ), the P2 pedestal asserts talk on line 3.
  const settled = scenarioRES({ ...TALK, T: 0.5, dt: 2e-5 });
  assert.ok(meanLevel(settled, '/P3', '/P1') > 10,
    `line 3 should be DC-hot off the P2 handshake once the filter settles, got ${meanLevel(settled, '/P3', '/P1').toFixed(2)} V`);
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
// so the permanently-wired codec (ES_OUTP→R26→C14→TX_OUT) — and the whole Ra/Cf/Rb filter leg hanging
// between the two open channels — cannot reach line 3: line 3 is high-Z at idle. The point of the dual gate.
test('TX idle isolation: codec audio must not reach line 3 when K1 is open (BUS-1)', () => {
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 }, program: { U1: { '/PTT_DRV': 0 }, U3: { out: { p: codecOut(1), n: codecOut(-1) } } }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.1, `K1 open should keep codec audio off line 3, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

test('talk handshake (K1): energised bridges the P2 supply onto line 3 through Ra+Rb; idle lifts it', () => {
  // K1 closes both halves: ch1 (/P2↔/TALK_BRIDGE) sources the handshake from the always-on P2 supply
  // into the low-pass — P2 → R34 (1.2 k) → HS_FILT (Cf ∥ via JP1) → R35 (1 k) → TX_OUT — and ch2
  // (/TX_OUT↔/P3) gates the output. Ra+Rb = 2.2 k total, the WF26's R1 mirrored, gong-stripped.
  // T must clear the RC settle (~3τ ≈ 160 ms): the default 40 ms window sits mid-ramp.
  const talk = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/PTT_DRV': 3.3 } }, T: 0.4 }).V;
  assert.ok(talk['/P3'] > 10, `K1 in talk should bring line 3 DC-hot off the P2 supply, got ${talk['/P3']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, program: { U1: { '/PTT_DRV': 0 } } }).V;
  assert.ok(!(idle['/P3'] > 6), `K1 idle should lift line 3 off the handshake, got ${idle['/P3']?.toFixed(2)} V`);
});

// The fallback is on the board: JP1 (bridged solder jumper) is Cf's only ground return. Cut, the leg
// degenerates to the plain 2.2 k strap — V4.1's step-assert handshake, no filter (see TODO).
test('JP1 cut (fallback): the leg degenerates to the plain 2.2 k strap — talk asserts with no ramp', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12 }, switches: { JP1: false },
    program: { U1: { '/PTT_DRV': 3.3 } }, T: 5e-3 });
  assert.ok(V['/P3'] > 10, `with Cf disconnected the strap should assert within ms (V4.1 behaviour), got ${V['/P3']?.toFixed(2)} V`);
});

// The reason the filter exists (capture-gated: our-ring-no-door — 1009/841/673 Hz Klänge on the
// latched P2): with PTT engaged, V4.1's direct strap dragged the gong onto line 3 over the greeting.
// The split leg passes the DC pedestal and shunts the AC at HS_FILT. ±8.8 V @ 1 kHz is the design
// ceiling (neighbour-ring case); raw through a 2.2 k strap that would be volts on P3.
test('gong rejection: a ±8.8 V 1 kHz gong riding P2 stays off line 3 while the handshake DC passes', () => {
  const gongP2 = (t) => 12 + 8.8 * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': gongP2 },
    program: { U1: { '/PTT_DRV': 3.3 }, U3: { out: 1.65 } }, T: 0.6, dt: 2e-5 });
  assert.ok(meanLevel(RES, '/P3', '/P1') > 10,
    `the pedestal must still assert talk under the gong, got ${meanLevel(RES, '/P3', '/P1').toFixed(2)} V`);
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.2,
    `the gong must die in the Ra/Cf divider, got ${(swingPP(RES, '/P3', '/P1') * 1000).toFixed(0)} mVpp on line 3 (raw input: 17.6 Vpp)`);
});

// Software TX must not accidentally transmit the passive handset microphone. The relevant state is
// K1 active with manual SW4 released: LS1 can still feed P4 through the gong capacitor and, while K5
// is latched, P2 through the seal-in. The Ra/Cf/Rb handshake filter must reject that voice-band path
// before it reaches P3. Exercise both K3 states because opening K3 physically removes the path, while
// the harder/default case leaves it connected and relies on Cf.
const softwareTxSwing = ({ mute, speakerTone, codecTone }) => {
  const switches = { ...defaultSwitchState(netlist), SW4: false };
  const tone = (t) => 1.65 + 0.4 * Math.sin(2 * Math.PI * 1000 * t); // 0.8 Vpp, centred like OUTP
  const els = buildElements(netlist, {
    switchState: switches,
    program: {
      U1: { '/PTT_DRV': 3.3, '/MUTE_DRV': mute ? 3.3 : 0 },
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
  const latched = run({ '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 12 }, 0.02).state;
  assert.ok(latched.relays.K5, 'precondition: the software-TX isolation scenario must have K5 latched');
  const speaker = speakerTone ? (t) => 0.4 * Math.sin(2 * Math.PI * 1000 * t) : undefined;
  const sources = { '/VBUS': 5, '/P1': 0, '/P2': 12 };
  if (speaker) sources['/P5'] = speaker;
  return run(sources, 0.6, latched, true).swing;
};

test('software TX isolation: the passive LS1 microphone stays small relative to codec TX', () => {
  // Drive LS1 with the same deliberately severe 0.8 Vpp used for the codec reference. Nominal Cf
  // leaves about -18.5 dB at 1 kHz; the real passive transducer is much quieter than the codec DAC.
  const maxLeakageRatio = 0.15;
  for (const mute of [false, true]) {
    const leaked = softwareTxSwing({ mute, speakerTone: true, codecTone: false });
    const wanted = softwareTxSwing({ mute, speakerTone: false, codecTone: true });
    assert.ok(wanted > 0.01, `codec TX reference must reach P3 with K3 ${mute ? 'open' : 'closed'}, got ${wanted.toFixed(4)} Vpp`);
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
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 0 }, program: { U1: { '/PTT_DRV': 3.3 } }, T: 0.4 });
  assert.ok(V['/P3'] > 10, `P2-sourced handshake should reach line 3 with no session, got ${V['/P3']?.toFixed(2)} V`);
});

// The session itself is the passive K5 latch: a Türruf energises the
// coil (line 4 ↔ P1) and its NO contact closes K1_COM onto line 4. (The seal-in from P2 after line 4
// drops is dynamic — exercised by the engine's relay latch, not this steady-state DC check.)
test('session latch: a Türruf pulls in K5 (its contact closes K1_COM onto line 4)', () => {
  const hot = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } }).V;
  assert.ok(near(hot['/K5_COM'], 12, 1.0), `a Türruf should pull the latch in (COM→line 4), got ${hot['/K5_COM']?.toFixed(2)} V`);

  const { V: idle, floating } = runDC(netlist, { sources: { '/P1': 0, '/P4': 0 } });
  assert.ok(!near(idle['/K5_COM'], 12, 1.0) || floating['/K5_COM'],
    `idle line 4 should leave the latch open, got ${idle['/K5_COM']?.toFixed(2)} V (floating=${floating['/K5_COM']})`);
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

const doorDrivePhase = ({ drive, T, seed, observe = false }) => {
  const step = 20e-6;
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
  const released = doorDrivePhase({ drive: false, T: gap, seed: first.state });
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

test('power OR: either input regulates +5V and +3V3', () => {
  for (const [input, name] of [['/USB_VBUS_IN', 'J1 USB-C'], ['/WALL_VBUS_IN', 'J3 wall feed']]) {
    const { V } = runDC(netlist, { sources: { [input]: 5, '/P1': 0 } });
    assert.ok(near(V['+3V3'], 3.3, 0.1), `${name}: +3V3 should regulate to ~3.3 V, got ${V['+3V3']?.toFixed(3)}`);
    assert.ok(V['+5V'] > 4.6 && V['+5V'] < 5.05, `${name}: +5V should sit just below the input, got ${V['+5V']?.toFixed(3)}`);
  }
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

test('power OR: either input is isolated from the other input and the fused rail', () => {
  for (const [active, inactive, activeName, inactiveName] of [
    ['/USB_VBUS_IN', '/WALL_VBUS_IN', 'J1 USB-C', 'J3 wall feed'],
    ['/WALL_VBUS_IN', '/USB_VBUS_IN', 'J3 wall feed', 'J1 USB-C'],
  ]) {
    const { V } = runDC(netlist, { sources: { [active]: 5, [inactive]: 0, '/P1': 0 } });
    assert.ok(V['+5V'] > 4.6, `${activeName} should power the fused +5V rail, got ${V['+5V']?.toFixed(2)} V`);
    assert.ok(V[inactive] < 0.5, `${activeName} must not back-feed ${inactiveName}, got ${V[inactive]?.toFixed(2)} V`);
  }

  const { V } = runDC(netlist, { sources: { '+5V': 5, '/USB_VBUS_IN': 0, '/WALL_VBUS_IN': 0, '/P1': 0 } });
  assert.ok(V['/USB_VBUS_IN'] < 0.5, `fused +5V must not back-feed J1, got ${V['/USB_VBUS_IN']?.toFixed(2)} V`);
  assert.ok(V['/WALL_VBUS_IN'] < 0.5, `fused +5V must not back-feed J3, got ${V['/WALL_VBUS_IN']?.toFixed(2)} V`);
});
