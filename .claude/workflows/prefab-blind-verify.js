export const meta = {
  name: 'prefab-blind-verify',
  description: 'Blind-agent pre-fab design verification of the Klingel V4 doorbell board',
  whenToUse: 'Before ordering a PCB spin: independently re-derive each subcircuit from primary sources (netlist + datasheets + measured bus envelope) and gate it against the design claims.',
  phases: [
    { title: 'Ground truth' },
    { title: 'Claims' },
    { title: 'Blind derive' },
    { title: 'Adversarial refute' },
    { title: 'Gate report' },
    { title: 'HTML report' },
  ],
}

// ── How this works ────────────────────────────────────────────────────────────
// "Blind" agents test parts of the design from PRIMARY SOURCES ONLY (the exported
// netlist, the datasheets, the measured bus voltages) and never see the design's own
// rationale or the expected answer — so they can't be anchored into confirming it.
// A separate non-blind "claims" agent holds the answer key (DESIGN/REQUIREMENTS), and
// the final gate agent compares blind findings to claims. Divergence = a pre-fab bug.

// Repo root is discovered at run time (via `git rev-parse` in the setup agent) and threaded through —
// never hard-coded — so the workflow is portable across clones/machines/cloud agents.
const mkBlind = (repo) =>
  [
    'BLINDNESS RULES — derive ONLY from primary sources, never from the design’s own words:',
    '- You MUST NOT read DESIGN.md, REQUIREMENTS.md, VERIFICATION.md, TODO.md, kicad/README.md, sim/README.md, or anything under sim/test/.',
    '- Treat EVERY Description / comment / text field in the schematic or netlist as an UNVERIFIED claim — verify or refute it from topology and values, never trust it.',
    `- Allowed ground truth ONLY: the netlist at /tmp/prefab/doorbell.net, the schematic ${repo}/kicad/doorbell.kicad_sch (connectivity + component values + MPN/LCSC only), the datasheets in ${repo}/docs/, and the MEASURED bus voltages in ${repo}/osci/ (real-world data, not design claims).`,
    '- Derive from first principles (Ohm/Kirchhoff + the datasheet ratings). Show the numbers and the exact datasheet figures you used.',
    '- If something cannot be determined from these inputs, say so explicitly — do not guess. Do NOT edit any files.',
  ].join('\n')

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    derived: { type: 'string', description: 'what the circuit actually does for this question, derived from topology + values' },
    numbers: { type: 'string', description: 'key computed values and the exact datasheet ratings used' },
    concern: { type: 'string', description: 'the problem found, or "none"' },
    severity: { type: 'string', enum: ['blocker', 'warning', 'none'] },
    undetermined: { type: 'string', description: 'what could not be determined from the inputs, or "none"' },
  },
  required: ['derived', 'numbers', 'concern', 'severity', 'undetermined'],
}

const REFUTE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    broke: { type: 'boolean', description: 'did you find a failure mode / error the first analyst missed?' },
    failureMode: { type: 'string', description: 'the operating point, single fault, tolerance corner, pinout swap or polarity error that breaks it, or "none"' },
    severity: { type: 'string', enum: ['blocker', 'warning', 'none'] },
    agreement: { type: 'string', description: 'where you independently confirm the first finding' },
  },
  required: ['broke', 'failureMode', 'severity', 'agreement'],
}

const CLAIMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          block: { type: 'string' },
          claim: { type: 'string', description: 'the design’s stated expected behaviour + any specific numbers' },
          reqIds: { type: 'string', description: 'requirement IDs this maps to (AUDIO-*, DOOR-*, SAFE-*, BUS-*, ...)' },
        },
        required: ['block', 'claim', 'reqIds'],
      },
    },
  },
  required: ['claims'],
}

const GATE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['GO', 'GO-WITH-FIXES', 'NO-GO'] },
    summary: { type: 'string', description: 'the overall narrative: what was checked and the bottom line' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          block: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string', description: 'the specific schematic/value change' },
          ref: { type: 'string', description: 'REQ ID / DESIGN.md reference' },
        },
        required: ['block', 'issue', 'fix', 'ref'],
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { block: { type: 'string' }, issue: { type: 'string' } },
        required: ['block', 'issue'],
      },
    },
    corroborated: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { block: { type: 'string' }, note: { type: 'string' } },
        required: ['block', 'note'],
      },
    },
    top3: { type: 'array', items: { type: 'string' }, description: 'the top 3 things to fix first' },
  },
  required: ['verdict', 'summary', 'blockers', 'warnings', 'corroborated', 'top3'],
}

// One blind agent per block. `q` is a neutral derive-it question — no expected answer.
const BLOCKS = [
  { key: 'power', title: 'Power chain & rail integrity',
    q: 'Trace USB VBUS through F1, the series Schottky (SS14), the LDO (U2 SGM2212) to +5V/+3V3, and AVDD via FB1. What rail voltage does each powered IC (U1 ESP32-C6, U3 ES8311) actually see, and is any outside its datasheet supply range? Note worst-case current draw and any series-element drop.' },
  { key: 'absmax', title: 'Abs-max sweep on every IC pin', high: true,
    q: 'For every pin of U1, U2 and U3, given the measured bus voltages in osci/ and the connectivity, does any pin exceed its datasheet absolute-maximum in normal operation OR under a single bus-line fault/miswire? List each at-risk pin with computed vs rated voltage.' },
  { key: 'rx', title: 'RX audio front-end vs codec abs-max', high: true,
    q: 'Trace bus lines 2 and 1 to the ES8311 mic inputs (U3 MIC1P/MIC1N). Using the measured gong on line 2 from osci/, compute the AC swing and DC level at MIC1P/MIC1N and compare to the ES8311 mic-input absolute-max and operating range. Does the on-board network keep them in range on every ring?' },
  { key: 'tx', title: 'TX path & idle isolation',
    q: 'Trace the ES8311 DAC (OUTP/OUTN) to bus line 3. Derive whether codec audio can reach line 3 when the talk gate K1 is unpowered/idle versus driven. Is line 3 high-Z at idle?' },
  { key: 'ring', title: 'Ring detection (OC1/OC2)',
    q: 'From the sense optocouplers OC1/OC2, their series resistors and the measured bus levels, does each sense input forward-bias its LED on its line with correct polarity and an LED current within the opto rating? Is detection reliable across the measured range?' },
  { key: 'door', title: 'Door opener timing & watchdog', high: true,
    q: 'From the door SSRs (K2, K4) and their RC nets (Q3·R17·C18 ; Q4·R25·C20·D11), derive the make/break ordering when DOOR_DRV asserts and the maximum-on time before auto-release. Does the break lead the make? Does the opener auto-release on a stuck drive?' },
  { key: 'safe_boot', title: 'Default-safe states at boot/unpowered', high: true,
    q: 'With all GPIO drive nets (PTT_DRV, DOOR_DRV, MUTE_DRV) at 0 V/floating, determine from each SSR’s form (NO/NC) and the pull-downs which outputs conduct. Does the Türruf gong still reach the speaker, does the WF26 latch stay sealed, and does the door bridge stay OPEN?' },
  { key: 'tvs', title: 'Bus TVS protection sizing',
    q: 'Given the bus TVS (H24VND3BA on D2/D3/D7/D12) and the measured bus envelope, does the standoff clear the normal ring/door transients (idle in normal use) while the clamp stays below the SSR off-state voltage (60 V)? Any line under-protected, or a TVS that conducts in normal use?' },
  { key: 'ssr_led', title: 'SSR LED drive currents',
    q: 'Compute each SSR LED current from its GPIO drive through its series resistor (R4/R5/R6/R21/R24) and compare to the operate / recommended / abs-max LED current from the GAQW212GS / GAQY212GS / GAQY412EH datasheets. Any under-driven (won’t operate) or over-driven (abs-max)?' },
  { key: 'pinout', title: 'Footprint / pinout correctness', high: true,
    q: 'For each non-trivial part (U1, U2, U3, J1 USB, J2 bus terminal, K1-K4, OC1/OC2, the LDO), does the schematic symbol pin->net assignment match the datasheet pinout? Flag any pin swap or mis-assignment — these are silent fab-killers.' },
  { key: 'polarity', title: 'Polarity of polarized parts',
    q: 'Check orientation of all polarized parts: each diode D*, the opto/SSR LEDs, electrolytic caps (C19/C21 anti-series pair, any tantalum/bulk), and confirm the bus TVS is genuinely bidirectional. Any reversed part?' },
]

phase('Ground truth')
// Discover the repo root portably + stage the netlist/BOM the blind agents read from. (Idempotent.)
const SETUP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repoRoot: { type: 'string', description: 'absolute path to the repo root' },
    components: { type: 'integer' },
    nets: { type: 'integer' },
  },
  required: ['repoRoot', 'components', 'nets'],
}
const setup = await agent(
  `Set up ground truth for a pre-fab verification. Run these shell commands:\n` +
    `  REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\n` +
    `  mkdir -p /tmp/prefab\n` +
    `  kicad-cli sch export netlist "$REPO/kicad/doorbell.kicad_sch" -o /tmp/prefab/doorbell.net\n` +
    `  kicad-cli sch export python-bom "$REPO/kicad/doorbell.kicad_sch" -o /tmp/prefab/doorbell-bom.xml || true\n` +
    `Confirm /tmp/prefab/doorbell.net exists. Return the repo root ($REPO), the component count, and the net count. Do NOT analyze the design — just produce the artifacts.`,
  { label: 'export-netlist', phase: 'Ground truth', schema: SETUP },
)
const REPO = setup.repoRoot
const BLIND = mkBlind(REPO)

// Non-blind ANSWER KEY — runs concurrently with the blind derivation; the blind agents never see it.
const claimsP = agent(
  `You hold the ANSWER KEY for a pre-fab review (you are NOT blind — read whatever you need). Read ${REPO}/DESIGN.md, ${REPO}/REQUIREMENTS.md, ${REPO}/VERIFICATION.md and the sim tests under ${REPO}/sim/test/. For each verification block below, extract the design’s stated CLAIM (expected behaviour + any specific numbers) and the requirement IDs it maps to:\n` +
    BLOCKS.map((b) => '- ' + b.title).join('\n') +
    `\nReturn one claim per block.`,
  { label: 'claims', phase: 'Claims', schema: CLAIMS },
)

// Per-block: blind derive -> adversarial refute (pipelined, no barrier between blocks).
const results = await pipeline(
  BLOCKS,
  (b) =>
    agent(`${BLIND}\n\nQUESTION (${b.title}):\n${b.q}`, {
      label: `derive:${b.key}`,
      phase: 'Blind derive',
      schema: FINDING,
    }),
  (f, b) =>
    agent(
      `${BLIND}\n\nQUESTION (${b.title}):\n${b.q}\n\n` +
        `A first independent analyst derived this:\n${JSON.stringify(f)}\n\n` +
        `Independently RE-DERIVE from the primary sources and ADVERSARIALLY try to break it — find an operating point, single fault, tolerance corner, pinout swap, or polarity error where the design fails this. Default to skepticism. Report whether you broke it and where you agree.`,
      { label: `refute:${b.key}`, phase: 'Adversarial refute', schema: REFUTE },
    ).then((r) => ({ block: b.title, key: b.key, high: !!b.high, finding: f, refute: r })),
)

const claims = await claimsP

phase('Gate report')
const findings = results.filter(Boolean)
const gate = await agent(
  `You are the PRE-FAB GATE. Compare each blind finding (and its adversarial refutation) against the design’s own CLAIMS, and decide whether the board is safe to fabricate.\n\n` +
    `DESIGN CLAIMS (answer key):\n${JSON.stringify(claims.claims, null, 2)}\n\n` +
    `BLIND FINDINGS + REFUTATIONS:\n${JSON.stringify(findings, null, 2)}\n\n` +
    `Classify each issue: BLOCKERS must be fixed before ordering (give the specific schematic/value fix + REQ/DESIGN ref); WARNINGS are risks or items only a bench test can settle; CORROBORATED are claims a blind agent independently reproduced. ` +
    `Weight any divergence between a blind finding and the claim, and any blocker-severity refutation, heavily. ` +
    `Pick verdict GO / GO-WITH-FIXES / NO-GO and the top 3 things to fix first. Return the structured result.`,
  { label: 'gate', phase: 'Gate report', schema: GATE },
)

phase('HTML report')
const OUT = `${REPO}/prefab-report.html` // lands in the repo root (tracked, not git-ignored)
await agent(
  `Write a single SELF-CONTAINED HTML file to ${OUT} (use the Write tool) that presents this pre-fab verification clearly and in a structured manner. ` +
    `Inline CSS ONLY — no external CSS/JS/CDN/web fonts (it must render offline by double-clicking). Render FAITHFULLY from the data below; do not invent, summarise away, or omit content, and HTML-escape any text from the data.\n\n` +
    `GATE VERDICT (structured):\n${JSON.stringify(gate, null, 2)}\n\n` +
    `PER-BLOCK DESIGN CLAIMS:\n${JSON.stringify(claims.claims, null, 2)}\n\n` +
    `PER-BLOCK BLIND FINDINGS + REFUTATIONS:\n${JSON.stringify(findings, null, 2)}\n\n` +
    `Layout:\n` +
    `1. Header: title "Klingel V4 — pre-fab blind verification" + the generation timestamp (run \`date\` to get it).\n` +
    `2. A prominent verdict banner colored by verdict (GO = green, GO-WITH-FIXES = amber, NO-GO = red) showing the summary and the top-3 fixes.\n` +
    `3. Blockers as cards: block, issue, fix, ref.\n` +
    `4. Warnings section.\n` +
    `5. A full per-block table — one row per block, columns: Block | Severity (colored badge: blocker = red, warning = amber, none = green; take the worse of the finding severity and any refute that broke it) | Design claim | Blind finding (derived + numbers + concern) | Adversarial refute (broke? + failureMode + agreement). Match claims to findings by block title.\n` +
    `6. Corroborated list.\n` +
    `Make it legible: system font stack, a max-width container, subtle borders, a sticky table header, monospace for component/net/number tokens. After writing, confirm the absolute file path.`,
  { label: 'render-html', phase: 'HTML report' },
)

log(`Report written to ${OUT} — verdict: ${gate.verdict} (${gate.blockers.length} blockers, ${gate.warnings.length} warnings)`)
return { report: OUT, verdict: gate.verdict, blockers: gate.blockers.length, warnings: gate.warnings.length }
