// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
//
// Architecture under test (see DESIGN.md / AUDIO_REFACTOR.md):
//  - K1/K2/K3 are PhotoMOS SSRs driven by a GPIO through a 300 Ω LED resistor on /PTT_DRV /DOOR_DRV /MUTE_DRV.
//    K1 (NO) gates /TALK_BRIDGE↔/P4 (the talk handshake); K2 (NO) bridges /P2↔/P3 (door opener);
//    K3 (NC) bridges /P4↔/CHIME_C1 (chime) — closed at rest, opened to suppress.
//  - The embedded WF26 core (WF26_K1 latch + S1/S2 + C1) is passive and works unpowered (SAFE-4).
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

test('WF26_S1 (door release) pressed shorts P2 onto P3', () => {
  const { V } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { WF26_S1: true } });
  assert.ok(near(V['/P3'], 12), `P3 should follow P2 to 12 V when S1 is pressed, got ${V['/P3']?.toFixed(3)}`);
});

test('WF26_S1 released does NOT tie P3 to P2', () => {
  const { V, floating } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { WF26_S1: false } });
  assert.ok(!near(V['/P3'], 12) || floating['/P3'],
    `P3 should not be at 12 V with S1 open, got ${V['/P3']?.toFixed(3)} (floating=${floating['/P3']})`);
});

test('WF26_S2 (talk) pressed bridges line 4 onto line 3 through R1 (the handshake)', () => {
  // S2 connects /WF26_R1_BRIDGE↔/P3; WF26_R1 (2.2 k) ties /P4↔/WF26_R1_BRIDGE. So a held line 4
  // reaches line 3 through R1 when S2 is pressed — the handset's own DC talk handshake.
  const { V } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { WF26_S2: true } });
  assert.ok(near(V['/P3'], 12, 1.0), `S2 pressed should bring P3 up toward line 4, got ${V['/P3']?.toFixed(3)}`);

  const { V: off } = runDC(netlist, { sources: { '/P4': 12, '/P1': 0 }, switches: { WF26_S2: false } });
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
// passes line 4 → /CHIME_C1; WF26_C1 (22 µF) couples the AC to /P5/LS1 and blocks the DC.
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

// Safety invariant (AUDIO_REFACTOR Decision 2 / the new GONG requirement): the Etagenruf (apartment
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

test('codec record (RX): a tone on line 2 reaches the ES8311 mic inputs (MICP/MICN)', () => {
  // RX taps line 2 differentially: /P2 → C16 → MICP, GND → C17 → MICN
  const tone = (t) => 1.0 * Math.sin(2 * Math.PI * 1000 * t); // 1 V on the line → 2 Vpp
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': tone }, ...AC });
  assert.ok(swingPP(RES, '/ES_MICP', '/ES_MICN') > 1.0,
    `line-2 audio should reach the codec ADC, got ${swingPP(RES, '/ES_MICP', '/ES_MICN').toFixed(2)} Vpp`);
});

test('codec talk (TX): the codec DAC (OUTP) couples onto line 3 through C14/R28', () => {
  // TX: ES_OUTP → C14 (DC-block) → /TALK_BRIDGE → R28 (2.2 k) → /P3
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t); // ±0.5 V differential DAC
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1) }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') > 0.5, `codec audio should reach line 3, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

// AUDIO_REFACTOR Decision 4/7 intends K1 to gate the TX *audio* so line 3 is high-Z at idle (BUS-1):
// `codec → DC-block → R16 → K1 → P3`. The current schematic instead wires the audio codec→C14→
// TALK_BRIDGE→R28→P3 permanently and uses K1 only to gate the DC handshake (TALK_BRIDGE↔line 4), so the
// codec couples onto line 3 regardless of K1 — line 3 is not high-Z while the codec is active but
// untalking. Open until the bench-gated audio front-end is finalised (AUDIO_REFACTOR open items / TODO).
test('TX idle isolation: codec audio must not reach line 3 when K1 is open (BUS-1)', { todo: true }, () => {
  const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * 1000 * t);
  const { RES } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1) }, ...AC });
  assert.ok(swingPP(RES, '/P3', '/P1') < 0.1, `K1 open should keep codec audio off line 3, got ${swingPP(RES, '/P3', '/P1').toFixed(2)} Vpp`);
});

test('talk handshake (K1): energised + line 4 held hot brings line 3 DC-hot; idle leaves it clear', () => {
  // K1 (NO) closes /TALK_BRIDGE↔/P4. With line 4 held by a session, the DC reaches line 3 through R28
  // (2.2 k) — the talk handshake to the station. TX is session-gated: no hot line 4 ⇒ no handshake.
  const talk = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 12, '/PTT_DRV': 3.3 } }).V;
  assert.ok(talk['/P3'] > 6, `K1 in talk should bring line 3 DC-hot off line 4, got ${talk['/P3']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 12, '/PTT_DRV': 0 } }).V;
  assert.ok(!(idle['/P3'] > 6), `K1 idle should leave line 3 clear of the handshake, got ${idle['/P3']?.toFixed(2)} V`);
});

// TX is deliberately session-gated (AUDIO_REFACTOR Decision 5, K1.4 → P4): the handshake DC comes from
// line 4, so the board can assert talk only while a Türruf session holds line 4 hot. K1 energised with
// no session must NOT drive line 3 — i.e. no autonomous announcement without an incoming call.
test('TX is session-gated: K1 energised with no session (line 4 cold) does not assert line 3', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P4': 0, '/PTT_DRV': 3.3 } });
  assert.ok(!(V['/P3'] > 1.0), `no session ⇒ no handshake on line 3, got ${V['/P3']?.toFixed(2)} V`);
});

// The session itself is the passive WF26_K1 latch (AUDIO_REFACTOR Decision 5): a Türruf energises the
// coil (line 4 ↔ P1) and its NO contact closes K1_COM onto line 4. (The seal-in from P2 after line 4
// drops is dynamic — exercised by the engine's relay latch, not this steady-state DC check.)
test('session latch: a Türruf pulls in WF26_K1 (its contact closes K1_COM onto line 4)', () => {
  const hot = runDC(netlist, { sources: { '/P1': 0, '/P4': 12 } }).V;
  assert.ok(near(hot['/WF26_K1_COM'], 12, 1.0), `a Türruf should pull the latch in (COM→line 4), got ${hot['/WF26_K1_COM']?.toFixed(2)} V`);

  const { V: idle, floating } = runDC(netlist, { sources: { '/P1': 0, '/P4': 0 } });
  assert.ok(!near(idle['/WF26_K1_COM'], 12, 1.0) || floating['/WF26_K1_COM'],
    `idle line 4 should leave the latch open, got ${idle['/WF26_K1_COM']?.toFixed(2)} V (floating=${floating['/WF26_K1_COM']})`);
});

// The session is a P2 seal-in (bench: osci/ring-20260617-195221.md, pending a dedicated handset
// confirmation — see TODO). A Türruf *pulse* on line 4 pulls WF26_K1 in; because P2 is *always*
// energised it then seals the coil in (`P2 → S1 NC → K1_COM → the closed NO contact → line 4 → coil`)
// and self-holds. **Dropping line 4 does NOT release it** — P2 holds it. The session ends via P2: the
// ~60 s timeout drives P2 low. A door-open also ends a session — but only the *handset's* button does
// it directly: S1 is a DPDT break-before-make that lifts P2 off K1_COM, dropping the latch (asserted in
// the WF26_S1 / DOOR-4 tests below). The board reproduces that break with K4 (an NC SSR in the seal-in)
// plus the Q1/RC make-delay on K2 — a hardware break-before-make (DOOR-4 test below).
test('session seal-in: dropping line 4 does NOT release WF26_K1 (P2 holds it); driving P2 low ends it', () => {
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const gnd = gndOf(netlist), dt = 20e-6;
  const settle = (srcs, seed) => {
    const sim = createStepper(els, srcs.map(([net, v]) => ({ net, vf: () => v })), gnd, dt, seed);
    for (let t = 0; t < 0.01; t += dt) sim.step(t);
    return sim.extractState();
  };
  // ring: line 4 pulsed hot with P2 energised -> pull in
  const latched = settle([['/P2', 12], ['/P4', 12], ['/P1', 0]]);
  assert.ok(latched.relays.WF26_K1, 'a Türruf should pull WF26_K1 in');
  // line 4 released (floats), P2 still energised: the latch self-holds — dropping line 4 does NOT release
  const held = settle([['/P2', 12], ['/P1', 0]], latched);
  assert.ok(held.relays.WF26_K1, 'dropping line 4 must NOT release the latch — P2 seals it in');
  // session end: P2 driven low (the ~60 s timeout) releases it
  const released = settle([['/P2', 0], ['/P1', 0]], latched);
  assert.ok(!released.relays.WF26_K1, 'driving P2 low (timeout) must release the latch');
});

// ── Door-open vs the WF26 latch (REQUIREMENTS DOOR-4 / MODE-3) ──────────────────────────────────────
// The handset's door button S1 is a DPDT break-before-make: pressing it lifts line 2 off the latch's
// seal-in node (K1_COM) *and* bridges P2↔P3, so WF26_K1 drops as the opener fires. In the sim the coil
// node (P4) is loaded by WF26_C1 (22 µF, via the closed K3) so it decays on an ~RC of a few tens of ms
// — far slower than the bench ~6 ms break-before-make (a model artifact) — so these settle ~100 ms and
// assert the END state, not the timing.
const latchSettle = (els, srcs, T, seed) => {
  const sim = createStepper(els, srcs.map(([net, v]) => ({ net, vf: () => v })), gndOf(netlist), 20e-6, seed);
  for (let t = 0; t < T; t += 20e-6) sim.step(t);
  return sim.extractState();
};

test('WF26_S1 (handset door button) releases the WF26_K1 latch — the break-before-make reference', () => {
  const ds = defaultSwitchState(netlist);
  const elsReleased = buildElements(netlist, { switchState: ds });
  const elsPressed = buildElements(netlist, { switchState: { ...ds, WF26_S1: true } });
  const latched = latchSettle(elsReleased, [['/P2', 12], ['/P4', 12], ['/P1', 0]], 0.01);
  assert.ok(latched.relays.WF26_K1, 'a Türruf should pull WF26_K1 in');
  const held = latchSettle(elsReleased, [['/P2', 12], ['/P1', 0]], 0.01, latched);
  assert.ok(held.relays.WF26_K1, 'dropping line 4 must not release the latch (P2 seal-in)');
  // press S1: it breaks P2→K1_COM (seal-in) and bridges P2↔P3 — the latch must drop, the door must fire
  const pressed = latchSettle(elsPressed, [['/P2', 12], ['/P1', 0]], 0.1, held);
  assert.ok(!pressed.relays.WF26_K1, 'pressing S1 must release WF26_K1 (it lifts P2 off the seal-in)');
  assert.ok(near(pressed.vn['/P3'], 12), `S1 press must bridge P2→P3 (door), got ${pressed.vn['/P3']?.toFixed(2)} V`);
});

test('DOOR-4: a board door-open (DOOR_DRV) releases WF26_K1 like S1', () => {
  // K4 (the NC seal-in-break SSR, driven off DOOR_DRV) opens the P2→K1_COM seal-in as the opener fires,
  // so the latch drops — DOOR-4 met. The break-before-make *lead* (K4 immediate, K2 delayed ~20 ms by
  // the Q1/R17/C18 RC) is NOT shown here: the sim's coil decay is RC-limited by C1's 22 µF (~60 ms) vs
  // the real ~6 ms, so the modelled latch drop trails K2's P3 bridge. We assert the END state — latch
  // released + door fired — which is what DOOR-4 requires.
  const els = buildElements(netlist, { switchState: defaultSwitchState(netlist) });
  const latched = latchSettle(els, [['/P2', 12], ['/P4', 12], ['/P1', 0]], 0.01);
  assert.ok(latched.relays.WF26_K1, 'a Türruf should pull WF26_K1 in');
  const held = latchSettle(els, [['/P2', 12], ['/P1', 0]], 0.01, latched);
  assert.ok(held.relays.WF26_K1, 'dropping line 4 must not release the latch (P2 seal-in)');
  const opened = latchSettle(els, [['/P2', 12], ['/P1', 0], ['/VBUS', 5], ['/DOOR_DRV', 3.3]], 0.12, held);
  assert.ok(!opened.relays.WF26_K1, 'DOOR-4: a board door-open must release the latch (K4 breaks the seal-in)');
  assert.ok(near(opened.vn['/P3'], 12), `door-open must fire the opener (P2→P3), got ${opened.vn['/P3']?.toFixed(2)} V`);
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
