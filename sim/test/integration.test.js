// Integration tests: run scenarios against the live schematic and assert on net voltages.
// The netlist is imported on the fly (reads the KiCad files via kicad-cli) — nothing baked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNetlist } from '../src/import.js';
import { runDC } from '../src/components/index.js';

const netlist = importNetlist();
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

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
