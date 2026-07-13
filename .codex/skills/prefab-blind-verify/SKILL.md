---
name: prefab-blind-verify
description: Independently gate the doorbell PCB for fabrication by deriving every subcircuit from the live KiCad netlist, local datasheets, and measured bus captures; adversarially checking the derivations; comparing them with the documented requirements; auditing coverage gaps; and producing a self-contained prefab-report.html. Use before ordering a PCB spin, when asked for prefab validation, blind verification, fabrication readiness, or a pre-fab GO/NO-GO report.
---

# Pre-fab blind verification

Perform a source-traceable hardware review without editing the design. Keep blind derivations isolated
from the repository's claims, then reconcile them only at the gate.

## Required resources

Read these files completely before starting:

- `references/review-blocks.md` for blindness rules and the review questions.
- `references/report-contract.md` for finding, refutation, gate, and HTML requirements.

Use `scripts/export-ground-truth.sh` to export `/tmp/prefab/doorbell.net` and the optional BOM XML.
Use the PDF skill when reading datasheets. Follow the repository's `AGENTS.md` throughout.

## Execution

1. Confirm the repository root and run the export helper. Stop if netlist export fails.
2. Build a part-to-datasheet map from schematic MPN, Value, LCSC, and Datasheet fields. Mark unmatched
   active or non-trivial parts `MISSING`; do not infer a datasheet from a similar part.
3. Inventory current assembly-preview evidence. JLCPCB order previews are authenticated,
   revision-specific external state and are not assumed accessible. If the user attached the current
   preview, stage the raw image under `/tmp/prefab/assembly-preview/`. If not, use an already signed-in
   browser session only when available and authorized, or ask the user to attach the relevant preview
   when a pinout/polarity conclusion depends on placement rotation. Continue other blocks while it is
   unavailable; never reuse a preview from another board revision, BOM, or CPL.
4. Extract one answer-key claim per review block from `DESIGN.md`, `REQUIREMENTS.md`,
   `VERIFICATION.md`, and `sim/test/`. Do this outside every blind agent.
5. Audit the block list for uncovered failure dimensions and functions without measurable
   requirements. Use the axes in `references/report-contract.md`.
6. Run every review block as an independent blind derivation. This skill explicitly requires
   subagents: spawn each blind agent with `fork_turns="none"` and give it only the blindness rules,
   authoritative part-to-datasheet map, block question, repository root, and output contract. Never
   pass claims, expected results, prior reports, TODOs, or conversation conclusions. Run bounded
   batches within the available concurrency.
7. Give each completed derivation to a fresh adversarial agent, also with `fork_turns="none"`. Require
   it to re-derive the block, try hard-break and performance-degradation modes, and reopen every cited
   PDF to verify the quoted rating, locator, and printed manufacturer.
8. Compare claims, derivations, refutations, assembly-preview evidence, and the coverage audit. Apply
   the gate rules in `references/report-contract.md`; do not soften functional contamination or
   unverifiable sources. A current fabrication preview may refute a numbering-based orientation
   inference; record the reconciliation explicitly instead of preserving a disproven finding.
9. Write `prefab-report.html` only after the gate completes successfully. Replace that external
   artifact atomically; never delete a usable previous report at startup. Keep it self-contained with
   inline CSS and no external assets.
10. Validate the HTML exists and contains the verdict, every review block, source audit results,
   coverage gaps, and blind spots. Report the verdict and counts to the user. Do not commit the report.

## Integrity rules

- Treat schematic descriptions and comments as claims, not evidence.
- Derive numbers from topology, values, measured stimuli, and the exact local PDF.
- Cite every datasheet rating with file, page/section, printed manufacturer, and a short quoted spec.
- Say `undetermined` instead of guessing. A missing load-bearing source prevents an unconditional GO.
- Never infer physical assembly polarity solely by equating an ordered part's terminal numbers with a
  generic footprint's pad numbers. Reconcile exact part marking, live PCB pad net/position, and the
  current assembly preview. If the preview is unavailable or ambiguous, say `undetermined`; do not
  claim a confirmed reversal.
- Keep V4.1 field evidence distinct from changed V4.2 circuitry.
- Do not modify schematic, PCB, firmware, documentation, tests, or the PDF during the review.
