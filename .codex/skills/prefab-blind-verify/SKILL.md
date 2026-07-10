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
3. Extract one answer-key claim per review block from `DESIGN.md`, `REQUIREMENTS.md`,
   `VERIFICATION.md`, and `sim/test/`. Do this outside every blind agent.
4. Audit the block list for uncovered failure dimensions and functions without measurable
   requirements. Use the axes in `references/report-contract.md`.
5. Run every review block as an independent blind derivation. This skill explicitly requires
   subagents: spawn each blind agent with `fork_turns="none"` and give it only the blindness rules,
   authoritative part-to-datasheet map, block question, repository root, and output contract. Never
   pass claims, expected results, prior reports, TODOs, or conversation conclusions. Run bounded
   batches within the available concurrency.
6. Give each completed derivation to a fresh adversarial agent, also with `fork_turns="none"`. Require
   it to re-derive the block, try hard-break and performance-degradation modes, and reopen every cited
   PDF to verify the quoted rating, locator, and printed manufacturer.
7. Compare claims, derivations, refutations, and the coverage audit. Apply the gate rules in
   `references/report-contract.md`; do not soften functional contamination or unverifiable sources.
8. Write `prefab-report.html` only after the gate completes successfully. Replace that external
   artifact atomically; never delete a usable previous report at startup. Keep it self-contained with
   inline CSS and no external assets.
9. Validate the HTML exists and contains the verdict, every review block, source audit results,
   coverage gaps, and blind spots. Report the verdict and counts to the user. Do not commit the report.

## Integrity rules

- Treat schematic descriptions and comments as claims, not evidence.
- Derive numbers from topology, values, measured stimuli, and the exact local PDF.
- Cite every datasheet rating with file, page/section, printed manufacturer, and a short quoted spec.
- Say `undetermined` instead of guessing. A missing load-bearing source prevents an unconditional GO.
- Keep V4.1 field evidence distinct from changed V4.2 circuitry.
- Do not modify schematic, PCB, firmware, documentation, tests, or the PDF during the review.
