// Model-coverage gate: every electrically-active part in the netlist must match an explicit,
// reviewed entry below — keyed on the SPECIFIC part, not a broad family.
//
// Why this exists: the component models pick parameters by heuristic (regex on lib/value). When a
// new part doesn't match a known variant the model layer silently falls back to a generic default,
// which can be flat wrong and only surfaces — if you're lucky — as a failing scenario test. That is
// exactly how a bidirectional TVS (H24VND3BA) once got modeled as a plain forward diode and pinned
// the whole bus to ~0.8 V. The lesson: matching "some TVS" is not enough; the gate must require the
// SPECIFIC part to be recognised. So adding a new active part fails this test until a human adds an
// entry here — which forces them to confirm the model actually handles it before they do.
//
// Scope: only the kinds whose model() guesses behaviour-defining electrical parameters. Passives
// (resistor/capacitor/inductor/fuse) and structural parts (switch/connector/testpoint/speaker/
// transformer/relay) are modelled generically from value/topology and are intentionally exempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importNetlist } from '../src/import.js';
import { allComponents } from '../src/components/index.js';

const GATED_KINDS = new Set(['diode', 'optocoupler', 'mosfet', 'protection', 'ic']);

// Each entry: { kind, match } where `match` is tested against "<lib> <value>" (the MPN often lives
// in the value, e.g. the LDO). Keep `match` specific enough to pin the variant whose parameters were
// reviewed. `note` documents how/why it's modelled (or that it is intentionally inert).
const KNOWN_ACTIVE_PARTS = [
  // diodes — Vf / reverse-breakdown / (bi)directionality all matter
  { kind: 'diode', match: /1N4148/i, note: 'silicon switching (~0.7 V), Is 1e-14' },
  { kind: 'diode', match: /Schottky|SS14/i, note: 'SS14 Schottky, low Vf' },
  { kind: 'diode', match: /\bLED\b/i, note: 'indicator LED, high Vf (~1.8 V)' },
  { kind: 'diode', match: /TVS-Uni,\s*SMF5\.0A|SMF5\.0A/i, note: 'unidirectional VBUS clamp; reverse-oriented, breaks down at vbr ~6.5 V to clamp a +VBUS surge' },
  { kind: 'diode', match: /TVS-Bi,\s*H24VND3BA|H24VND3BA/i, note: 'bidirectional bus TVS: anti-series Zeners, ~24 V standoff / ~31 V breakdown (vbr 30)' },
  { kind: 'diode', match: /BAT54/i, note: 'BAT54S series dual Schottky as codec-OUTP rail clamp (A→GND, K→+3V3, COM=ES_OUTP); idles within [0,AVDD], clamps OUTP to ~[−0.3, +3.6] V on the C14-coupled transient / C14-short fault (modelled by DiodeArray)' },

  // PhotoMOS / opto — form (NO/NC), Ron and LED operate current define switching behaviour
  { kind: 'optocoupler', match: /GAQW212GS/i, note: 'dual 1-Form-A PhotoMOS (NO), Ron ~0.8 Ω/ch (datasheet)' },
  { kind: 'optocoupler', match: /GAQY212GS/i, note: '1-Form-A PhotoMOS (NO), Ron ~0.24 Ω' },
  { kind: 'optocoupler', match: /GAQY412EH/i, note: '1-Form-B PhotoMOS (NC), Ron ~1 Ω' },
  { kind: 'optocoupler', match: /LTV-217|PC817/i, note: 'phototransistor optocoupler (Türruf/Etagenruf sense)' },

  // MOSFET — Vgs(th) / Rds(on)
  { kind: 'mosfet', match: /2N7002/i, note: 'NMOS (incl. 2N7002DW dual), Vth ~2.1 V, Ron ~5 Ω' },

  // protection IC — internal clamp voltages
  { kind: 'protection', match: /TPD2S017/i, note: 'USB D± ESD array, ~6 V rail clamp' },

  // ICs
  { kind: 'ic', match: /SGM2212/i, note: 'main +3V3 LDO regulator (modelled); VIN abs-max 22 V' },
  { kind: 'ic', match: /LP5907/i, note: 'audio AVDD LDO 3.3 V (LP5907, bare IN/OUT/GND pins); modelled as LDO, VIN abs-max 6 V' },
  { kind: 'ic', match: /ESP32-S3/i, note: 'MCU — not electrically modelled; driven by test scenarios' },
  { kind: 'ic', match: /ES8311/i, note: 'audio codec — supply-current load + VMID reference (AVDD/2) modelled; digital function (I2S/DAC/ADC) not, driven by test scenarios' },
];

test('model coverage: every active part matches a reviewed model entry (no silent heuristic fallback)', () => {
  const netlist = importNetlist();
  const offenders = [];

  for (const c of allComponents(netlist)) {
    if (!GATED_KINDS.has(c.kind)) continue;
    const sig = `${c.lib} ${c.value}`;
    const known = KNOWN_ACTIVE_PARTS.some((e) => e.kind === c.kind && e.match.test(sig));
    if (!known) offenders.push(`${c.ref} [${c.kind}]  ${c.lib}  "${c.value}"`);
  }

  assert.equal(
    offenders.length,
    0,
    `Active part(s) with no reviewed model-coverage entry:\n  ${offenders.join('\n  ')}\n\n` +
      `Each guesses its electrical parameters by heuristic, so an unrecognised part is silently\n` +
      `mis-modelled. Before adding an entry to KNOWN_ACTIVE_PARTS in this file, confirm the relevant\n` +
      `component model (src/components/) actually handles this specific part correctly.`,
  );
});

// Second gate: nothing may land on the Unmodeled catch-all silently. A part that matches NO model class
// emits no sim elements at all — it's electrically invisible. That's only safe when it's deliberate. When
// it isn't, the part fails open and unnoticed: FB1 (a ferrite bead = a DC short on the AVDD rail) fell
// here because its matcher missed, silently opening the rail and floating AVDD. So a truly new /
// unrecognised part must be given a model (preferred) or explicitly acknowledged here — never ignored.
const KNOWN_UNMODELED_PARTS = [
  // Parts intentionally left electrically inert. Add { match, note } only after confirming the part
  // genuinely has no electrical role in the sim (e.g. a mechanical-only or fiducial part).
  //   { match: /SomeMechanicalPart/i, note: 'no electrical role' },
];

test('model coverage: no part silently falls to the Unmodeled fallback', () => {
  const netlist = importNetlist();
  const offenders = [];

  for (const c of allComponents(netlist)) {
    if (c.kind !== 'unknown') continue; // 'unknown' is the Unmodeled catch-all class, nothing else
    const known = KNOWN_UNMODELED_PARTS.some((e) => e.match.test(`${c.lib} ${c.value}`));
    if (!known) offenders.push(`${c.ref} [${c.kind}]  ${c.lib}  "${c.value}"`);
  }

  assert.equal(
    offenders.length,
    0,
    `Part(s) that match no model class — silently inert (emit no sim elements):\n  ${offenders.join('\n  ')}\n\n` +
      `An unmodelled part fails open and invisibly (e.g. a ferrite/jumper that should short a rail). Give\n` +
      `it a model in src/components/ (preferred), or — only if it genuinely has no electrical role — add\n` +
      `an explicit { match, note } to KNOWN_UNMODELED_PARTS in this file.`,
  );
});
