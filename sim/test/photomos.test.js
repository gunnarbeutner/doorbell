// PhotoMOS SSR model tests — the GAQY212GS (1-Form-A, normally open) and GAQY412EH (1-Form-B,
// normally closed) solid-state relays. The board isn't updated yet, so the model is exercised both
// by building SSR elements directly (engine behaviour) and by classifying synthetic raw components
// (the import → component mapping). Uses Node's test runner, like integration.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStepper } from '../src/engine.js';
import { classify } from '../src/components/index.js';

const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// settle a circuit to its DC operating point and hand back the stepper (vn / padInjections()) plus the
// set of source-driven nets (whose KCL residual is supplied by the source, so they're not "internal").
function settle(els, sources, gnd = 'GND', T = 0.02, dt = 20e-6) {
  const srcs = Object.entries(sources).map(([net, v]) => ({ net, vf: typeof v === 'function' ? v : () => v }));
  const sim = createStepper(els, srcs, gnd, dt);
  const steps = Math.max(1, Math.round(T / dt));
  for (let k = 0; k <= steps; k++) sim.step(k * dt);
  const V = (n) => (n === gnd ? 0 : sim.vn[sim.ni[n]] || 0);
  const driven = new Set([gnd, ...Object.keys(sources)]);
  return { sim, V, driven };
}

// a PhotoMOS element: NO (closedWhenOn:true, Ron 0.24) or NC (false, Ron 1). LED 1->2, output 3<->4.
function ssr({ form = 'NO', ron = form === 'NC' ? 1 : 0.24, ref = 'K1' } = {}) {
  return {
    type: 'SSR', a: 'LEDA', b: 'LEDK', c: 'OUT', d: 'ORET',
    pa: '1', pb: '2', pc: '3', pd: '4',
    closedWhenOn: form !== 'NC', ron, iop: 3e-3, Is: 1e-13, n: 1.9, ref,
  };
}
const R = (a, b, value, ref) => ({ type: 'R', a, b, value, ref, pa: '1', pb: '2' });

// LED drive loop: VDR -> Rled -> LEDA -[LED]- LEDK -> 1Ω -> GND. `rled` sets the forward current.
function ledDrive(rled) {
  return [R('VDR', 'LEDA', rled, 'RLED'), R('LEDK', 'GND', 1, 'RKRET')];
}
// output sense loop: VOUT -> Rs -> OUT -[switch]- ORET -> Rret -> GND
function outLoad(rs = 1000, rret = 1) {
  return [R('VOUT', 'OUT', rs, 'RS'), R('ORET', 'GND', rret, 'RRET')];
}

// per-net current balance from padInjections() (sign: + into the net) — every *internal* net (not a
// source, not GND) must sum to ~0. Tolerance matches the engine's own audit scale.
function assertBalanced(sim, driven, tol = 1e-6) {
  const sum = {};
  for (const inj of sim.padInjections()) sum[inj.net] = (sum[inj.net] || 0) + inj.I;
  for (const n in sum) {
    if (driven.has(n)) continue;
    assert.ok(Math.abs(sum[n]) < tol, `internal net ${n} KCL residual ${sum[n].toExponential(2)} should be ~0`);
  }
}
const Iat = (sim, ref, pin) => (sim.padInjections().find((p) => p.ref === ref && p.pin === pin) || {}).I || 0;

// ── NO (GAQY212GS): output closed only when the LED is energized ──

test('NO: LED energized -> output closes (passes the line near 0 V through Ron)', () => {
  const els = [ssr(), ...ledDrive(330), ...outLoad()];
  const { sim, V, driven } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  // closed: OUT pulled near GND through Ron + Rret (both << 1 kΩ source) -> small residual
  assert.ok(V('OUT') < 0.05, `closed output should pull OUT near 0, got ${V('OUT').toFixed(4)} V`);
  assertBalanced(sim, driven);
});

test('NO: LED de-energized -> output open (line stays pulled up)', () => {
  const els = [ssr(), ...outLoad()]; // no LED drive at all
  const { sim, V, driven } = settle(els, { VOUT: 5, LEDA: 0, LEDK: 0, GND: 0 });
  assert.ok(near(V('OUT'), 5, 0.01), `open output should leave OUT at 5 V, got ${V('OUT').toFixed(4)} V`);
  assertBalanced(sim, driven);
});

// ── NC (GAQY412EH): output closed at rest, opened by energizing the LED ──

test('NC: LED de-energized -> output closed at rest (fail-safe pass-through)', () => {
  const els = [ssr({ form: 'NC' }), ...outLoad()];
  const { sim, V, driven } = settle(els, { VOUT: 5, LEDA: 0, LEDK: 0, GND: 0 });
  assert.ok(V('OUT') < 0.05, `NC at rest should pass OUT to GND, got ${V('OUT').toFixed(4)} V`);
  assertBalanced(sim, driven);
});

test('NC: LED energized -> output opens (line releases to its pulled-up level)', () => {
  const els = [ssr({ form: 'NC' }), ...ledDrive(330), ...outLoad()];
  const { sim, V, driven } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  assert.ok(near(V('OUT'), 5, 0.02), `energized NC should open, OUT ~5 V, got ${V('OUT').toFixed(4)} V`);
  assertBalanced(sim, driven);
});

// ── bidirectional output: conducts BOTH polarities (not a one-way diode) ──

test('output conducts both current polarities through Ron', () => {
  for (const drive of [12, -12]) {
    const els = [ssr(), ...ledDrive(330), ...outLoad()];
    const { sim, V, driven } = settle(els, { VDR: 3.3, VOUT: drive, GND: 0 });
    assert.ok(Math.abs(V('OUT')) < 0.06, `closed output should pass ${drive} V near 0, got ${V('OUT').toFixed(4)} V`);
    const Iout = Iat(sim, 'K1', '3'); // + into the OUT net; current flows OUT->ORET when OUT > 0
    assert.ok(Math.abs(Iout) > 1e-3, `current should flow through the closed output, got ${Iout.toExponential(2)} A`);
    assert.equal(Math.sign(Iout), -Math.sign(drive), `output current reverses with the drive polarity (${drive} V)`);
    assertBalanced(sim, driven);
  }
});

// ── correct on-resistance: a known series R forms a divider with Ron (+ the 1 Ω return) ──

test('Ron is ~0.24 Ω (NO) — recovered from the divider', () => {
  const Rs = 100, Rret = 0.01; // small return R so it barely perturbs the divider
  const els = [ssr(), ...ledDrive(330), R('VOUT', 'OUT', Rs, 'RS'), R('ORET', 'GND', Rret, 'RRET')];
  const { V } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  // V(OUT)-V(ORET) is the drop across Ron; I = (5 - V(OUT))/Rs; Ron = (V(OUT)-V(ORET))/I
  const I = (5 - V('OUT')) / Rs;
  const ron = (V('OUT') - V('ORET')) / I;
  assert.ok(near(ron, 0.24, 0.02), `recovered Ron should be ~0.24 Ω, got ${ron.toFixed(3)} Ω`);
});

test('Ron is ~1 Ω (NC at rest)', () => {
  const Rs = 100, Rret = 0.01;
  const els = [ssr({ form: 'NC' }), R('VOUT', 'OUT', Rs, 'RS'), R('ORET', 'GND', Rret, 'RRET')];
  const { V } = settle(els, { VOUT: 5, LEDA: 0, LEDK: 0, GND: 0 });
  const I = (5 - V('OUT')) / Rs;
  const ron = (V('OUT') - V('ORET')) / I;
  assert.ok(near(ron, 1, 0.05), `recovered Ron should be ~1 Ω, got ${ron.toFixed(3)} Ω`);
});

// ── operate threshold: just below ~3 mA the LED stays "off"; above it switches ──

test('operate threshold: LED current below ~3 mA does not switch the NO output', () => {
  const els = [ssr(), ...ledDrive(2200), ...outLoad()]; // (3.3 - ~1.1)/2200 ~ 1 mA, sub-threshold
  const { sim, V, driven } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  const Iled = -Iat(sim, 'K1', '1'); // pin 1 injects -Iled into LEDA
  assert.ok(Iled < 3e-3, `LED current should be sub-threshold here, got ${(Iled * 1e3).toFixed(2)} mA`);
  assert.ok(near(V('OUT'), 5, 0.02), `sub-threshold LED must leave the NO output open, got ${V('OUT').toFixed(4)} V`);
  assertBalanced(sim, driven);
});

test('operate threshold: LED current above ~3 mA switches the NO output closed', () => {
  const els = [ssr(), ...ledDrive(330), ...outLoad()]; // (3.3 - ~1.1)/330 ~ 6.7 mA, above threshold
  const { sim, V } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  const Iled = -Iat(sim, 'K1', '1');
  assert.ok(Iled > 3e-3, `LED current should be above threshold here, got ${(Iled * 1e3).toFixed(2)} mA`);
  assert.ok(V('OUT') < 0.05, `above-threshold LED must close the NO output, got ${V('OUT').toFixed(4)} V`);
});

// ── galvanic isolation: input and output share no node; each internal net balances by KCL ──

test('LED and output sides are isolated and each balances by KCL', () => {
  const els = [ssr(), ...ledDrive(330), ...outLoad()];
  const { sim } = settle(els, { VDR: 3.3, VOUT: 5, GND: 0 });
  const sum = {};
  for (const inj of sim.padInjections()) sum[inj.net] = (sum[inj.net] || 0) + inj.I;
  for (const n of ['LEDA', 'LEDK', 'OUT', 'ORET']) {
    assert.ok(Math.abs(sum[n] || 0) < 1e-6, `${n} residual ~0, got ${(sum[n] || 0).toExponential(2)}`);
  }
  // input current (LED) and output current are independent — energizing the LED draws ~6.7 mA while the
  // output carries ~5 mA through its own loop; neither pin set shares a net with the other side
  assert.ok(Math.abs(Iat(sim, 'K1', '1')) > 3e-3 && Math.abs(Iat(sim, 'K1', '3')) > 1e-3, 'both sides carry current');
});

// ── import → component classification (the real parts, recognized by lib / value / footprint) ──

test('classify: GAQY212GS is modeled as a normally-open PhotoMOS (Ron 0.24 Ω)', () => {
  const raw = { ref: 'K1', lib: 'gaqy212gs:GAQY212GS', value: 'GAQY212GS', footprint: 'PCM:SOP-4_L4.3-W4.4-P2.54-LS6.8-TR', pins: { 1: 'A', 2: 'K', 3: 'C', 4: 'D' } };
  const c = classify(raw);
  assert.equal(c.constructor.name, 'Photomos', 'GAQY212GS should classify as Photomos');
  const [e] = c.elements();
  assert.equal(e.type, 'SSR');
  assert.equal(e.closedWhenOn, true, 'NO: closes when LED energized');
  assert.ok(near(e.ron, 0.24, 1e-6), `Ron should be 0.24 Ω, got ${e.ron}`);
  assert.deepEqual([e.a, e.b, e.c, e.d], ['A', 'K', 'C', 'D']);
  assert.deepEqual([e.pa, e.pb, e.pc, e.pd], ['1', '2', '3', '4']);
});

test('classify: GAQY412EH is modeled as a normally-closed PhotoMOS (Ron 1 Ω)', () => {
  const raw = { ref: 'K3', lib: 'gaqy412eh:GAQY412EH', value: 'GAQY412EH', footprint: 'PCM:SMD-4_L4.8-W6.4-P2.54-LS9.6-BL', pins: { 1: 'A', 2: 'K', 3: 'C', 4: 'D' } };
  const c = classify(raw);
  assert.equal(c.constructor.name, 'Photomos', 'GAQY412EH should classify as Photomos');
  const [e] = c.elements();
  assert.equal(e.closedWhenOn, false, 'NC: closes when LED de-energized');
  assert.ok(near(e.ron, 1, 1e-6), `Ron should be 1 Ω, got ${e.ron}`);
});

test('classify: recognized by footprint alone (blank lib/value)', () => {
  const no = classify({ ref: 'K1', lib: '', value: '', footprint: 'SOP-4_L4.3-W4.4-P2.54-LS6.8-TR', pins: { 1: 'A', 2: 'K', 3: 'C', 4: 'D' } });
  assert.equal(no.constructor.name, 'Photomos');
  assert.equal(no.elements()[0].closedWhenOn, true, 'SOP-4 footprint -> NO');

  const nc = classify({ ref: 'K3', lib: '', value: '', footprint: 'SMD-4_L4.8-W6.4-P2.54-LS9.6-BL', pins: { 1: 'A', 2: 'K', 3: 'C', 4: 'D' } });
  assert.equal(nc.constructor.name, 'Photomos');
  assert.equal(nc.elements()[0].closedWhenOn, false, 'SMD-4 W6.4 footprint -> NC');
});
