# Report contract

## Finding

Return one object per blind derivation with:

- `derived`: actual behavior derived from topology and values.
- `numbers`: calculations and exact ratings used.
- `concern`: problem or `none`.
- `severity`: `blocker`, `warning`, or `none`.
- `undetermined`: missing evidence or `none`.
- `sources`: for every datasheet rating, exact file under `docs/`, page/table/section locator,
  manufacturer exactly as printed, and a short quoted specification.

## Adversarial refutation

Return:

- `broke`: whether a missed hard failure or performance degradation exists.
- `failureMode`, `severity`, and `agreement`.
- `sourceVerified`: true only after reopening every cited PDF and finding every rating at its locator
  with the same printed manufacturer.
- `sourceProblems`: all missing, mismatched, or apparently remembered sources, or `none`.

## Claims and coverage

For every block, record the design claim and mapped requirement IDs. Audit at least these dimensions:
DC operating point, absolute maximum, connectivity/pinout, polarity, AC behavior, noise/PSRR,
thermal, timing/jitter, EMI/coupling, cross-signal contamination, composed-state reachability,
transition transients, tolerance corners, and MCU per-pin/aggregate drive budget.

List uncovered dimensions with why, suggested owning block, and severity. List functions lacking a
numeric requirement with a proposed measurable requirement.

## Gate

Return `GO`, `GO-WITH-FIXES`, or `NO-GO`, plus summary, blockers, warnings, corroborated claims, top
three actions, and explicit blind spots.

- A blocker requires correction before ordering and names a specific fix plus requirement/design ref.
- A warning is a bounded risk or question only bench evidence can settle.
- An unintended signal within roughly 20 dB of intended, or a material transition thump, is a
  functional defect even when all ratings pass.
- Any `sourceVerified: false` block is at least a warning and is a blocker when the unverified rating
  is load-bearing for GO.
- For JLCPCB-assembled polarized parts, a confirmed orientation finding requires agreement among the
  exact ordered-part marking, live PCB pad net/physical position, and current order preview. Do not
  promote a terminal-number-versus-generic-pad-number discrepancy to a confirmed reversal. If the
  authenticated current preview is unavailable or ambiguous, record assembly orientation as
  `undetermined`; continue the review and request the preview rather than guessing.
- When current assembly-preview evidence refutes a blind or adversarial numbering inference, the gate
  must show the refutation, update the block severity/counts, and retain only the unresolved source
  gaps. Never carry a disproven blocker into the verdict.
- A blocker-severity uncovered dimension is itself NO-GO-class until resolved.
- Fold every coverage gap and every `undetermined` item into `blindSpots`; a verdict is conditional on
  this complete list.

## HTML

Create one offline `prefab-report.html` with inline CSS and:

1. Title `Doorbell controller — pre-fab blind verification` and generation timestamp.
2. Prominent colored verdict, summary, and top-three actions.
3. Blocker cards with issue, fix, and reference.
4. Warnings.
5. One table row per review block: severity, design claim, derivation/numbers/concern, cited sources,
   source-verification status, and adversarial result.
6. Corroborated claims.
7. Coverage and blind-spots callout, uncovered-dimension table, and unspecified-function table.

HTML-escape all generated text. Use a system font stack, restrained colors, legible tables, subtle
borders, monospace for nets/parts/numbers, and a sticky table header. Do not omit or invent content.
