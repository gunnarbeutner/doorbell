// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNetlist } from '../src/import.js';
import { runDC } from '../src/components/index.js';

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

// the loudspeaker's two terminals (LS1)
const SPEAKER = Object.values(netlist.components.find((c) => c.ref === 'LS1').pins);

test('WF26_S1 (door release) pressed shorts P2 onto P3', () => {
  const { V } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { WF26_S1: true } });
  assert.ok(near(V['/P3'], 12), `P3 should follow P2 to 12 V when S1 is pressed, got ${V['/P3']?.toFixed(3)}`);
});

test('WF26_S1 released does NOT tie P3 to P2', () => {
  const { V, floating } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 }, switches: { WF26_S1: false } });
  assert.ok(!near(V['/P3'], 12) || floating['/P3'],
    `P3 should not be at 12 V with S1 open, got ${V['/P3']?.toFixed(3)} (floating=${floating['/P3']})`);
});

// K2's coil runs off the +5V rail, so the board must be powered (VBUS) for it to pull in.
test('GATE2_DRV = 3.3 V energizes K2 (door opener) -> P3 = P2', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/GATE2_DRV': 3.3 } });
  assert.ok(near(V['/P3'], 12), `energized K2 should tie P3 to P2 (12 V), got ${V['/P3']?.toFixed(3)}`);
});

test('GATE2_DRV = 0 V leaves K2 idle -> P3 not pulled to P2', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/GATE2_DRV': 0 } });
  assert.ok(!near(V['/P3'], 12), `idle K2 should not tie P3 to 12 V, got ${V['/P3']?.toFixed(3)}`);
});

test('power rails: +3V3 regulated, +5V behind the Schottky', () => {
  const { V } = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0 } });
  assert.ok(near(V['+3V3'], 3.3, 0.1), `+3V3 should regulate to ~3.3 V, got ${V['+3V3']?.toFixed(3)}`);
  assert.ok(V['+5V'] > 4.6 && V['+5V'] < 5.05, `+5V should sit just below VBUS, got ${V['+5V']?.toFixed(3)}`);
});

test('transformer blocks DC: a 12 V level on P2 does not appear on the secondary', () => {
  const { V } = runDC(netlist, { sources: { '/P2': 12, '/P1': 0 } });
  assert.ok(Math.abs(V['/SEC_A']) < 1 && Math.abs(V['/SEC_B']) < 1,
    `SEC_A/SEC_B should be ~0 (DC blocked), got ${V['/SEC_A']?.toFixed(3)} / ${V['/SEC_B']?.toFixed(3)}`);
});

test('unpowered board: rails float, no phantom voltage', () => {
  const { V, floating } = runDC(netlist, { sources: {} });
  assert.ok(floating['+3V3'], '+3V3 should be flagged floating with no sources');
  assert.ok(Math.abs(V['+3V3']) < 0.5, `+3V3 should be ~0 unpowered, got ${V['+3V3']?.toFixed(3)}`);
});

// Each audio test sweeps two axes: board power (the handset path is passive, so it must work either
// way) and the solder bridges (which connect the board's lines to the embedded handset). The bridges
// move together — a mixed J3/J4 state isn't a real configuration. Closed -> the tone is heard; open ->
// the handset is isolated from the lines and the speaker is silent.
const POWER = [
  ['powered (VBUS = 5 V)', { '/VBUS': 5 }],
  ['unpowered (no VBUS)', {}],
];
const BRIDGES = [
  ['bridges closed', {}, true], //                      handset connected to the lines -> heard
  ['bridges open', { J3: false, J4: false }, false], // handset isolated -> silent
];

// apartment ring (Etagenruf): an AC tone on line 5 drives the handset loudspeaker directly
const f = 1000; // 1 kHz, 2 V amplitude (4 Vpp)
const tone = (t) => 2 * Math.sin(2 * Math.PI * f * t);

for (const [pwr, power] of POWER) {
  for (const [brg, bridges, heard] of BRIDGES) {
    test(`apartment ring: P5 tone at the loudspeaker — ${pwr}, ${brg}`, () => {
      const { RES } = runDC(netlist, {
        sources: { ...power, '/P1': 0, '/P5': tone },
        switches: bridges,
        T: 8 / f,
        dt: 1 / (f * 256),
      });
      const pp = swingPP(RES, SPEAKER[0], SPEAKER[1]);

      if (heard) assert.ok(pp > 3.5, `LS1 should play the ~2 V tone (~4 Vpp), got ${pp.toFixed(2)} Vpp`);
      else assert.ok(pp < 0.5, `handset isolated -> LS1 should be silent, got ${pp.toFixed(2)} Vpp`);
    });
  }
}

// ringing the station (Türruf gong): line 4 held at 12 V DC during the ~1 s ring with the gong tone
// superimposed. The DC energizes the session; only the AC couples through C1 to the speaker. We sample
// a window inside the ring — the coupling settles in ~2 ms, so the full second isn't needed.
for (const [pwr, power] of POWER) {
  for (const [brg, bridges, heard] of BRIDGES) {
    test(`ringing the station: P4 gong at the loudspeaker — ${pwr}, ${brg}`, () => {
      const fGong = 1000;
      const ring = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * fGong * t); // 12 V DC + 1.5 V tone

      const { RES } = runDC(netlist, {
        sources: { ...power, '/P1': 0, '/P2': 12, '/P4': ring },
        switches: bridges,
        T: 12 / fGong,
        dt: 1 / (fGong * 64),
      });
      const ac = swingPP(RES, SPEAKER[0], SPEAKER[1]);

      if (heard) {
        const dc = meanLevel(RES, SPEAKER[0], SPEAKER[1]);
        assert.ok(ac > 1.0, `the gong tone should couple through C1 to LS1, got ${ac.toFixed(2)} Vpp`);
        assert.ok(Math.abs(dc) < 1.0, `C1 should block the 12 V DC (no cone offset), got ${dc.toFixed(2)} V`);
      } else {
        assert.ok(ac < 0.5, `handset isolated -> LS1 should be silent, got ${ac.toFixed(2)} Vpp`);
      }
    });
  }
}

// ── call detection: the sense optocouplers (OC1 on the Türruf line, OC2 on the Etagenruf line) ──
// Each LED hangs off a bus line through a 5.1 kΩ limiter to P1; the phototransistor collector is
// pulled to +3V3 (10 kΩ) and read by the ESP. So a hot line pulls the GPIO low = "ringing". These
// need the board powered (the +3V3 rail biases the collector pull-ups).

test('Türruf detection: a hot line 4 (IN_P4) pulls OC1_OUT low; idle line stays high', () => {
  const hot = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/IN_P4': 12 } }).V;
  assert.ok(hot['/OC1_OUT'] < 1.0, `a ringing line 4 should pull OC1_OUT low, got ${hot['/OC1_OUT']?.toFixed(2)} V`);

  const idle = runDC(netlist, { sources: { '/VBUS': 5, '/P1': 0, '/IN_P4': 0 } }).V;
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

// ── chime suppress: K3 (DESIGN.md "suppress the chime by switching line 4") ──
// At rest K3 passes the incoming gong IN_P4 -> P4 (it rings, and OC1 still senses it). Energising K3
// breaks P4 off the line: the chime goes silent while OC1 keeps detecting on the retained IN_P4 side.
const fGong = 1000;
const gong = (t) => 12 + 1.5 * Math.sin(2 * Math.PI * fGong * t); // incoming Türruf: 12 V DC + gong tone

test('chime suppress: K3 idle passes the gong to the speaker AND OC1 still detects it', () => {
  const { V, RES } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/IN_P4': gong }, // GATE3_DRV unset -> K3 idle
    T: 12 / fGong,
    dt: 1 / (fGong * 64),
  });
  const ac = swingPP(RES, SPEAKER[0], SPEAKER[1]);
  assert.ok(ac > 1.0, `K3 idle should let the gong reach LS1, got ${ac.toFixed(2)} Vpp`);
  assert.ok(V['/OC1_OUT'] < 1.0, `OC1 should detect the ring, got ${V['/OC1_OUT']?.toFixed(2)} V`);
});

test('chime suppress: K3 energised silences the speaker but OC1 keeps detecting', () => {
  const { V, RES } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/IN_P4': gong, '/GATE3_DRV': 3.3 }, // K3 pulled in
    T: 12 / fGong,
    dt: 1 / (fGong * 64),
  });
  const ac = swingPP(RES, SPEAKER[0], SPEAKER[1]);
  assert.ok(ac < 0.5, `K3 energised should silence the chime at LS1, got ${ac.toFixed(2)} Vpp`);
  assert.ok(V['/OC1_OUT'] < 1.0, `detection must survive suppression (OC1 on the retained side), got ${V['/OC1_OUT']?.toFixed(2)} V`);
});

test('chime suppress fail-safe: IN_P4 and P4 stay bridged when the ESP is unpowered (K3 idle)', () => {
  // no VBUS at all -> the ESP can never pull K3 in, so the gong must still pass to the handset
  const { V } = runDC(netlist, { sources: { '/P1': 0, '/IN_P4': 12 } });
  assert.ok(near(V['/P4'], 12), `unpowered, K3 NC must bridge IN_P4 -> P4, got ${V['/P4']?.toFixed(2)} V`);
});

// ── handset talk (up-audio): the handset speaker doubles as the mic. Pressing S2 (Sprechen) bridges
// the mic -> C1 -> R1 onto line 3 (DESIGN.md line 179). Inject a tone at the speaker, look for it on P3.
const fVoice = 1000;
const mic = (t) => 1.0 * Math.sin(2 * Math.PI * fVoice * t); // ~1 V mic-level tone at LS1

test('handset talk (S2): pressing S2 puts the mic signal onto line 3 (P3); releasing it does not', () => {
  const acRun = (switches) =>
    runDC(netlist, { sources: { '/P1': 0, '/WF26_P5': mic }, switches, T: 8 / fVoice, dt: 1 / (fVoice * 256) }).RES;

  const talk = acRun({ WF26_S2: true });
  const ppTalk = swingPP(talk, '/P3', '/P1');
  assert.ok(ppTalk > 0.5, `S2 pressed should bridge the mic onto P3, got ${ppTalk.toFixed(2)} Vpp`);

  const quiet = acRun({ WF26_S2: false });
  const ppQuiet = swingPP(quiet, '/P3', '/P1');
  assert.ok(ppQuiet < 0.1, `S2 released should leave P3 clear of mic audio, got ${ppQuiet.toFixed(2)} Vpp`);
});

// ── codec talk / record (ES8311 ↔ line, through T1 with K1 in talk). The codec's differential DAC
// (OUTP/OUTN) feeds the transformer secondary through C14/C15 + R24/R25; its ADC (MICP/MICN) taps the
// same secondary through R26/R27 + C16/C17. K1 in talk routes the transformer's primary onto line 3.
// (U3 is unmodeled, so we drive/read its analog pins directly; the ADC pins read "floating" — no DC
// load — but the AC couples faithfully, which is what we measure.)
const fAudio = 1000;
const codecOut = (ph) => (t) => 0.5 * ph * Math.sin(2 * Math.PI * fAudio * t); // ±0.5 V differential DAC

test('codec talk: ES8311 audio (OUTP/OUTN) reaches line 3 only when K1 is in talk', () => {
  // realistic call: P2 held at 12 V, line 4 held hot by the session (so the talk handshake is live)
  const run = (sources) =>
    runDC(netlist, {
      sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/IN_P4': 12, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1), ...sources },
      T: 16 / fAudio,
      dt: 1 / (fAudio * 128),
    }).RES;

  const talk = run({ '/GATE1_DRV': 3.3 }); // K1 energised: T1 primary -> P3
  assert.ok(swingPP(talk, '/P3', '/P1') > 0.5, `codec audio should reach line 3 in talk, got ${swingPP(talk, '/P3', '/P1').toFixed(2)} Vpp`);

  const listen = run({}); // K1 idle: T1 primary parked on P2, so line 3 stays clear
  assert.ok(swingPP(listen, '/P3', '/P1') < 0.1, `codec audio should not leak onto line 3 at rest, got ${swingPP(listen, '/P3', '/P1').toFixed(2)} Vpp`);
});

// During codec talk, the K1 pole-A handshake (R28, 2.2 kΩ from line 4) must hold line 3 DC-hot — exactly
// as the handset's S2 strap does (~12 V) — since that's what signals talk to the station. This FAILS
// today: K1 pole B hangs the transformer primary (115 Ω winding, no bus-side DC block) onto line 3 and
// shunts the handshake down to ~0.6 V (the same winding also pulls ~100 mA off the held line in listen).
// Marked todo until a series DC-blocking cap is added in series with the transformer's bus winding; then
// line 3 should sit near line 4 (~12 V) with the codec AC riding on top.
test('codec talk: line 3 sits DC-hot from the talk handshake (needs the bus-winding DC-block cap)', { todo: true }, () => {
  const { RES } = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P2': 12, '/IN_P4': 12, '/GATE1_DRV': 3.3, '/ES_OUTP': codecOut(1), '/ES_OUTN': codecOut(-1) },
    T: 16 / fAudio,
    dt: 1 / (fAudio * 128),
  });
  const dc = meanLevel(RES, '/P3', '/P1');
  assert.ok(dc > 10, `line 3 should be DC-hot near line 4 (~12 V) during talk, got ${dc.toFixed(2)} V`);
});

test('codec record: an AC signal on line 3 reaches the ES8311 mic inputs (MICP/MICN) when K1 is in talk', () => {
  const sig = (t) => 1.0 * Math.sin(2 * Math.PI * fAudio * t); // 1 V on the line

  const rec = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/GATE1_DRV': 3.3, '/P3': sig },
    T: 16 / fAudio,
    dt: 1 / (fAudio * 128),
  }).RES;
  assert.ok(swingPP(rec, '/ES_MICP', '/ES_MICN') > 1.0, `line audio should reach the codec ADC, got ${swingPP(rec, '/ES_MICP', '/ES_MICN').toFixed(2)} Vpp`);

  const idle = runDC(netlist, {
    sources: { '/VBUS': 5, '/P1': 0, '/P3': sig }, // K1 idle: P3 not tied to the transformer
    T: 16 / fAudio,
    dt: 1 / (fAudio * 128),
  }).RES;
  assert.ok(swingPP(idle, '/ES_MICP', '/ES_MICN') < 0.1, `with K1 idle, P3 should not reach the ADC, got ${swingPP(idle, '/ES_MICP', '/ES_MICN').toFixed(2)} Vpp`);
});

// ── Tier 2: protection / power front-end ──

test('ESD array (D5): a surge on the USB data line is clamped to ~VBUS, not passed to the ESP', () => {
  // a 500 V transient through a 330 Ω source impedance (the IEC ESD network) onto D-
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
