// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
//
// Architecture under test (see DESIGN.md):
//  - K1/K2/K3 are PhotoMOS SSRs driven by a GPIO through a 300 Ω LED resistor on /PTT_DRV /DOOR_DRV /MUTE_DRV.
//    K1 (NO) gates /TALK_BRIDGE↔/P4 (the talk handshake); K2 (NO) bridges /P2↔/P3 (door opener);
//    K3 (NC) bridges /P4↔/CHIME_C1 (chime) — closed at rest, opened to suppress.
//  - The embedded WF26 core (K5 latch + S1/S2 + C1) is passive and works unpowered (SAFE-4).
//  - Audio is transformer-less: RX taps /P2 through C16 to the ES8311 ADC (MICP/MICN); TX runs the
//    codec DAC (OUTP) through C14 → /TALK_BRIDGE → R28 (2.2 k) → /P3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNetlist } from '../src/import.js';
import { runDC, buildElements, defaultSwitchState } from '../src/components/index.js';
import { createStepper, gndOf } from '../src/engine.js';

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
  const on = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/DOOR_DRV': 3.3 } }).V;
  assert.ok(near(on['/P3'], 12), `energised K2 should tie P3 to P2 (12 V), got ${on['/P3']?.toFixed(3)}`);

  const off = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/DOOR_DRV': 0 } }).V;
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
  const { V, RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': gong, '/MUTE_DRV': 3.3 }, ...AC }); // K3 opened
  assert.ok(swingPP(RES, SPEAKER[0], SPEAKER[1]) < 0.5,
    `K3 energised should silence the chime at LS1, got ${swingPP(RES, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  assert.ok(V['/OC1_OUT'] < 1.0, `detection must survive suppression (OC1 on line 4, ahead of K3), got ${V['/OC1_OUT']?.toFixed(2)} V`);
});

test('chime suppress fail-safe: line 4 stays bridged to C1 when the ESP is unpowered (K3 NC closed)', () => {
  // no VBUS → the ESP can never open K3, so the gong path (line 4 → /CHIME_C1) must stay made
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } });
  assert.ok(near(V['/CHIME_C1'], 12), `unpowered, K3 NC must bridge line 4 → /CHIME_C1, got ${V['/CHIME_C1']?.toFixed(2)} V`);
});

// Safety invariant (GONG requirement — the Etagenruf must always ring): the Etagenruf (apartment
// door — someone physically at your own door) reaches LS1 directly on line 5, bypassing K3, so it is
// *structurally* non-suppressible. K3 can mute only the Türruf (through C1). The guarantee is hardware,
// not firmware — so it must hold even in the very state that suppresses the Türruf.
test('Etagenruf is structurally non-suppressible: K3 energised mutes the Türruf but not line 5', () => {
  const tone = (t) => 2 * Math.sin(2 * Math.PI * 1000 * t);
  const ring = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * 1000 * t);
  // in the suppressing state, the Türruf gong on line 4 is muted ...
  const turruf = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': ring, '/MUTE_DRV': 3.3 }, ...AC }).RES;
  assert.ok(swingPP(turruf, SPEAKER[0], SPEAKER[1]) < 0.5,
    `K3 energised should mute the Türruf, got ${swingPP(turruf, SPEAKER[0], SPEAKER[1]).toFixed(2)} Vpp`);
  // ... yet the Etagenruf on line 5 stays audible in that same state
  const etagen = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P5': tone, '/MUTE_DRV': 3.3 }, ...AC }).RES;
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
  // feed the real +3V3 rail; AVDD comes up through FB1 (now modelled as a DC short)
  const { RES, V, floating } = runDC(netlist, {
    sources: { '+3V3': 3.3, '/P1': 0, '/P2': gong },
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
    sources: { '+3V3': 3.3, '/P1': 0, '/P2': tone },
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

test('codec talk (TX): the codec DAC (OUTP) reaches line 3 only while K1 is talking (gated)', () => {
  // K1-gated TX audio: ES_OUTP → C14 (DC-block) → /TALK_BRIDGE → R28 (2.2 k) → /TX_OUT → K1 ch2 → /P3.
  // K1 energised (PTT asserted) closes ch2 so the codec couples onto line 3; idle isolation is below.
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t); // ±0.5 V differential DAC
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/PTT_DRV': 3.3, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1) }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') > 0.5, `codec audio should reach line 3 while talking, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

// BUS-1: the dual GAQW212GS gates the TX *output* — ch2 (/TX_OUT↔/P3). With K1 open that contact lifts,
// so the permanently-wired codec (ES_OUTP→C14→TALK_BRIDGE→R28→TX_OUT) cannot reach line 3: line 3 is
// high-Z at idle. This is the whole point of the dual gate.
test('TX idle isolation: codec audio must not reach line 3 when K1 is open (BUS-1)', () => {
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/PTT_DRV': 0, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1) }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.1, `K1 open should keep codec audio off line 3, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

test('talk handshake (K1): energised bridges the P2 supply onto line 3 through R28; idle lifts it', () => {
  // K1 closes both halves: ch1 (/P2↔/TALK_BRIDGE) sources the handshake from the always-on P2 supply and
  // ch2 (/TX_OUT↔/P3) gates the output. P2 → TALK_BRIDGE → R28 (2.2 k) → TX_OUT → P3 — the DC talk
  // handshake to the station (mirrors the WF26's 2.2 k talk R). Idle: both contacts open, line 3 lifts.
  const talk = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/PTT_DRV': 3.3 } }).V;
  assert.ok(talk['/P3'] > 6, `K1 in talk should bring line 3 DC-hot off the P2 supply, got ${talk['/P3']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/PTT_DRV': 0 } }).V;
  assert.ok(!(idle['/P3'] > 6), `K1 idle should lift line 3 off the handshake, got ${idle['/P3']?.toFixed(2)} V`);
});

// TX is deliberately session-INDEPENDENT (gated-TX requirement: the board may assert talk whenever it
// chooses, even with no incoming Türruf). The handshake is sourced from P2 — which the bus keeps
// energised at all times — not from line 4, so K1 energised drives line 3 with line 4 cold. Policy for
// *when* to talk lives in firmware, not this hardware gate.
test('TX is session-independent: K1 energised drives line 3 from P2 with line 4 cold (no Türruf)', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/P4': 0, '/PTT_DRV': 3.3 } });
  assert.ok(V['/P3'] > 6, `P2-sourced handshake should reach line 3 with no session, got ${V['/P3']?.toFixed(2)} V`);
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

// The session is a P2 seal-in (bench: osci/our-ring-door-open.md, pending a dedicated handset
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
  const opened = latchSettle(els, [['/P2', 12], ['/P1', 0], ['/VBUS', 5], ['/DOOR_DRV', 3.3]], 0.12, held);
  assert.ok(!opened.relays.K5, 'DOOR-4: a board door-open must release the latch (K4 breaks the seal-in)');
  assert.ok(near(opened.vn['/P3'], 12), `door-open must fire the opener (P2→P3), got ${opened.vn['/P3']?.toFixed(2)} V`);
});

// ── Door-open max-on-time watchdog (Q3 unit 2 + R25/C20/D11) ─────────────────────────────────────
// The door opener is the K2 bridge (P2↔P3). If the ESP hangs with /DOOR_DRV latched high the door
// would stay "pressed", so a hardware one-shot limits it: /DOOR_DRV charges /WD_GATE through R25
// (3 M) · C20 (2.2 µF) ≈ 6.6 s; once /WD_GATE passes the FET threshold, Q3 unit 2 pulls /DELAY_GATE
// low, turning off Q3 unit 1 (K2's break-before-make low-side switch) → K2 opens → the bridge drops.
// The normal 1.75 s firmware pulse ends long before the timeout, so a real open is never cut short.

test('door watchdog: an armed /WD_GATE drops the K2 bridge even with /DOOR_DRV held high', () => {
  // drive /WD_GATE high directly to stand in for the charged RC — tests the mechanism, not the timing
  const armed = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/DOOR_DRV': 3.3, '/WD_GATE': 3.3 } }).V;
  assert.ok(!near(armed['/P3'], 12, 2.0), `an armed watchdog must drop the door bridge, got P3=${armed['/P3']?.toFixed(2)} V`);

  // with /WD_GATE held low (RC not yet charged) the same drive keeps the door open
  const open = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/DOOR_DRV': 3.3, '/WD_GATE': 0 } }).V;
  assert.ok(near(open['/P3'], 12), `un-armed, the door must stay open, got P3=${open['/P3']?.toFixed(2)} V`);
});

test('door watchdog timing: /DOOR_DRV stuck high opens the door, then self-releases after the RC timeout', () => {
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const dt = 2e-3;
  const sim = createStepper(els,
    [['/VBUS', 5], ['/P1', 0], ['/P2', 12], ['/DOOR_DRV', 3.3]].map(([net, v]) => ({ net, vf: () => v })),
    gndOf(netlist), dt);
  // door fires and is still bridged at 1 s (the RC is nowhere near threshold). This also guards the
  // R25 value: a 1000× too-small R would time out in milliseconds and fail right here.
  for (let t = 0; t < 1.0; t += dt) sim.step(t);
  const open = sim.extractState();
  assert.ok(near(open.vn['/P3'], 12), `door should be open at 1 s, got P3=${open.vn['/P3']?.toFixed(2)} V`);
  // run past the ~6.6 s timeout: the watchdog must drop the bridge though /DOOR_DRV is still asserted
  for (let t = 1.0; t < 10.0; t += dt) sim.step(t);
  const released = sim.extractState();
  assert.ok(!near(released.vn['/P3'], 12, 2.0), `watchdog should release the door by 10 s, got P3=${released.vn['/P3']?.toFixed(2)} V`);
});

// ── power & protection front-end ──

test('power rails: +3V3 regulated, +5V behind the Schottky', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 } });
  assert.ok(near(V['+3V3'], 3.3, 0.1), `+3V3 should regulate to ~3.3 V, got ${V['+3V3']?.toFixed(3)}`);
  assert.ok(V['+5V'] > 4.6 && V['+5V'] < 5.05, `+5V should sit just below VBUS, got ${V['+5V']?.toFixed(3)}`);
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
    sources: { '/VBUS': 5, '/SURGE': 500 },
    extra: [{ type: 'R', a: '/SURGE', b: '/USB_DN', value: 330 }],
  });
  assert.ok(V['/USB_ESP_DN'] < 8, `D5 should clamp the ESP-side line near VBUS, got ${V['/USB_ESP_DN']?.toFixed(2)} V`);
  assert.ok(V['/USB_ESP_DN'] > 4, `the steering diode should clamp to ~VBUS+Vf, got ${V['/USB_ESP_DN']?.toFixed(2)} V`);
});

test('+5V Schottky (D4) blocks back-feed: driving +5V does not push current back into VBUS_F', () => {
  const { V } = runDC(netlist, { sources: { '+5V': 5, '/VBUS': 0 } });
  assert.ok(V['/VBUS_F'] < 0.5, `D4 should block +5V from back-feeding VBUS_F, got ${V['/VBUS_F']?.toFixed(2)} V`);
});
