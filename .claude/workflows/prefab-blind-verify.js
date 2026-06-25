export const meta = {
  name: 'prefab-blind-verify',
  description: 'Blind-agent pre-fab design verification of the Klingel V4 doorbell board',
  whenToUse: 'Before ordering a PCB spin: independently re-derive each subcircuit from primary sources (netlist + datasheets + measured bus envelope) and gate it against the design claims.',
  phases: [
    { title: 'Ground truth' },
    { title: 'Claims' },
    { title: 'Coverage audit' },
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
    `- ROLE, NOT REFDES: the QUESTIONS describe parts by FUNCTION/role (e.g. "the MCU", "the main 3.3 V regulator", "the bus-line TVS array"), NOT by refdes. Resolve the actual refdes, MPNs and nets yourself from the netlist + schematic — enumerate EVERY part matching a role (a role may map to several parts, or to one the question never anticipated). Never assume a refdes; if no part matches a named role, say so.`,
    `- BRAND & RATINGS FROM THE PDF, NEVER FROM MEMORY: a part's manufacturer, ratings, and recommended operating values are whatever the docs/ datasheet PDF actually prints — never infer them from the part number or from a better-known part it resembles. Many parts here are second-sources/clones (e.g. GAQ… is NOT the Panasonic AQ… it is modeled on); assume nothing until you have opened the file. Every datasheet rating you use must be one you READ in a docs/ PDF and can quote with its file + page — a plausible recalled number is NOT allowed.`,
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
    sources: {
      type: 'array',
      description: 'EVERY datasheet rating used in `numbers` must be traced here to the docs/ PDF it was read from. If a rating has no entry here, you may not use it. Empty only if the block uses no datasheet ratings at all.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'exact path under docs/, e.g. docs/GAQY212GS_datasheet.pdf' },
          locator: { type: 'string', description: 'page + table/section where the rating appears, e.g. "p.2, Electrical Characteristics"' },
          manufacturerAsPrinted: { type: 'string', description: 'the brand EXACTLY as printed on the datasheet header — NEVER inferred from the part number (writing a brand the PDF does not show is a process error)' },
          quotedSpec: { type: 'string', description: 'the rating copied verbatim from the PDF, e.g. "Input LED current (Recommended value): IF ≥5mA and ≤30mA"' },
        },
        required: ['file', 'locator', 'manufacturerAsPrinted', 'quotedSpec'],
      },
    },
  },
  required: ['derived', 'numbers', 'concern', 'severity', 'undetermined', 'sources'],
}

const REFUTE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    broke: { type: 'boolean', description: 'did you find a failure mode the first analyst missed — a hard break OR a "works but out of spec" degradation?' },
    failureMode: { type: 'string', description: 'the operating point, single fault, tolerance corner, pinout swap or polarity error that BREAKS it, OR the disturbance / noise-coupling / insufficient-rejection / tolerance-stack mode where it keeps functioning but MISSES A PERFORMANCE NUMBER (noise floor, SNR, level, accuracy, settling, margin), or "none"' },
    severity: { type: 'string', enum: ['blocker', 'warning', 'none'] },
    agreement: { type: 'string', description: 'where you independently confirm the first finding' },
    sourceVerified: { type: 'boolean', description: 'did you OPEN each docs/ PDF the first analyst cited in `sources` and confirm every rating appears at the stated locator AND the manufacturerAsPrinted matches the file? false if any rating could not be located, any brand mismatched the PDF, or the analyst used a rating with no source entry.' },
    sourceProblems: { type: 'string', description: 'any rating that is not traceable to a docs/ PDF, any brand that does not match the cited file, or any number that looks recalled-from-memory rather than read — "none" if all sources check out.' },
  },
  required: ['broke', 'failureMode', 'severity', 'agreement', 'sourceVerified', 'sourceProblems'],
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

// Verification-COVERAGE audit (fixes the "a missing block is a silent, total blind spot" failure):
// what failure DIMENSIONS does no block own, and what FUNCTIONS have no numeric requirement to check.
const COVERAGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    uncoveredDimensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dimension: { type: 'string', description: 'the failure dimension no block examines (e.g. "analog supply noise / in-band PSRR")' },
          why: { type: 'string', description: 'what can fail here and why no existing block would catch it' },
          suggestedBlock: { type: 'string', description: 'the verification block that should exist to own it' },
          severity: { type: 'string', enum: ['blocker', 'warning', 'none'] },
        },
        required: ['dimension', 'why', 'suggestedBlock', 'severity'],
      },
    },
    unspecifiedFunctions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subsystem: { type: 'string' },
          functionLacking: { type: 'string', description: 'a function with no numeric requirement to verify against (no noise floor / SNR / accuracy / margin)' },
          suggestedRequirement: { type: 'string', description: 'the measurable requirement (with a number) that should be added' },
        },
        required: ['subsystem', 'functionLacking', 'suggestedRequirement'],
      },
    },
  },
  required: ['uncoveredDimensions', 'unspecifiedFunctions'],
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
    blindSpots: {
      type: 'array',
      description: 'failure dimensions this review did NOT examine — the coverage boundary the verdict is conditional on (a GO is GO *except for* these)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { dimension: { type: 'string' }, why: { type: 'string' } },
        required: ['dimension', 'why'],
      },
    },
  },
  required: ['verdict', 'summary', 'blockers', 'warnings', 'corroborated', 'top3', 'blindSpots'],
}

// One blind agent per block. `q` is a neutral derive-it question — no expected answer.
const BLOCKS = [
  { key: 'power', title: 'Power chain & rail integrity',
    q: 'Trace the USB power input through every series protection element (fuse, reverse-protection diode, any TVS) and every voltage regulator to the supply pin of each powered IC — INCLUDING any secondary/analog regulator that feeds a noise-sensitive rail through a ferrite/filter. What voltage does each IC supply pin and each regulator output actually see, and is any outside the datasheet supply range for that part? Note worst-case current draw and the drop across every series element.' },
  { key: 'absmax', title: 'Abs-max sweep on every IC pin', high: true,
    q: 'For every pin of every active IC on the board, given the measured bus voltages in osci/ and the connectivity, does any pin exceed its datasheet absolute-maximum in normal operation OR under a single bus-line fault/miswire? List each at-risk pin with computed vs rated voltage.' },
  { key: 'rx', title: 'RX audio front-end vs codec abs-max', high: true,
    q: 'Trace the bus listen pair (lines 2 and 1) to the audio codec microphone/analog input pins. Using the measured gong on line 2 from osci/, compute the AC swing and DC level at those input pins and compare to the codec mic-input absolute-max and operating range. Does the on-board network keep them in range on every ring?' },
  { key: 'tx', title: 'TX path & idle isolation',
    q: 'Trace the audio codec DAC output(s) to the bus talk line. Derive whether codec audio can reach that line when the talk-gate SSR is unpowered/idle versus driven. Is the talk line high-Z at idle?' },
  { key: 'ring', title: 'Ring detection (bus-line sense optos)',
    q: 'From the bus ring-sense optocouplers, their series resistors and the measured bus levels, does each sense input forward-bias its LED on its line with correct polarity and an LED current within the opto rating? Is detection reliable across the measured range?' },
  { key: 'door', title: 'Door opener timing & watchdog', high: true,
    q: 'From the door-opener SSRs and their RC timing nets (the FET plus the RC network around each), derive the make/break ordering when the door-drive signal asserts and the maximum-on time before auto-release. Does the break lead the make? Does the opener auto-release on a stuck drive?' },
  { key: 'safe_boot', title: 'Default-safe states at boot/unpowered', high: true,
    q: 'With all MCU GPIO drive nets to the SSRs at 0 V/floating, determine from each SSR form (NO/NC) and the gate pull-downs which outputs conduct. Does the Türruf gong still reach the speaker, does the WF26 latch stay sealed, and does the door bridge stay OPEN?' },
  { key: 'tvs', title: 'Bus TVS protection sizing',
    q: 'Given the per-line bus TVS array and the measured bus envelope, does each TVS standoff clear the normal ring/door transients (idle in normal use) while its clamp stays below the off-state voltage rating of the bus SSRs? Any line under-protected, or a TVS that conducts in normal use?' },
  { key: 'ssr_led', title: 'SSR LED drive currents',
    q: 'Compute each SSR LED current from its MCU GPIO drive through its series resistor and compare to the operate / recommended / abs-max LED current from THAT SSR datasheet. Use the MCU datasheet-GUARANTEED VOH at the relevant drive current (not the rail) for the worst-case current, so the recommended-floor margin is real and not assumed. THEN check fan-out: identify where a single GPIO net drives MORE THAN ONE LED (e.g. one drive net feeding two series resistors into a dual SSR), SUM that pin total source current, and compare each driving pin total to the MCU per-GPIO source-current limit. Any LED under-driven (will not operate at guaranteed VOH), over-driven (abs-max), or any GPIO pin sourcing more than its rated current?' },
  { key: 'pinout', title: 'Footprint / pinout correctness', high: true,
    q: 'For every non-trivial part on the board (each active IC and regulator, every connector, the SSRs, the optocouplers — anything with a datasheet pinout), does the schematic symbol pin->net assignment match the datasheet pinout? Flag any pin swap or mis-assignment — these are silent fab-killers.' },
  { key: 'polarity', title: 'Polarity of polarized parts',
    q: 'Check orientation of all polarized parts: every diode, the opto/SSR input LEDs, every electrolytic/tantalum/bulk cap (including any anti-series non-polar pair), and confirm the bus TVS array is genuinely bidirectional. Any reversed part?' },
  // ADEQUACY (not correctness): a part can be connected and within abs-max yet still inadequate.
  { key: 'supply_integrity', title: 'Analog / reference supply integrity (in-band noise)', high: true,
    q: 'For every ANALOG or REFERENCE supply pin and every noise-sensitive input that is fed through a filter network (a rail reaching an IC via a ferrite/RC + bypass caps, or a reference/bias pin with filter caps), identify the DOMINANT aggressor on the upstream rail — LDO output noise, the WiFi-TX load-step droop, digital switching hash — using the measured envelopes in osci/ where available. Then compute the filter network’s rejection |H(f)| ACROSS THE PIN’S BAND OF INTEREST (not just at HF), state the residual aggressor (in dB or volts) that survives onto the pin, and compare it to what that pin’s FUNCTION can tolerate. Beware frequency-dependent parts: a ferrite is ~0 Ω at low frequency, so give |H| at the ACTUAL in-band frequency, not the part’s rated HF impedance. Flag any sensitive pin whose surviving in-band noise is large relative to the signal it carries.' },
  { key: 'ds_conformance', title: 'Datasheet typical-application / reference-design conformance', high: true,
    q: 'For each active IC on the board (the MCU, every regulator, the audio codec, any USB-protection IC), open its datasheet in docs/ and locate the TYPICAL-APPLICATION schematic plus any "recommended" / "must" / "for best performance" application or layout guidance — supply decoupling, dedicated/separate supplies, reference filter caps, grounding/star-point, series elements. Enumerate each such recommendation as a line item and mark the on-board implementation PASS or DEVIATE versus it, citing the exact datasheet figure/section and the schematic refdes/values. An implemented topology that DEVIATES from a "recommended" application requirement WITHOUT a stated justification is a finding even if every pin is connected and in range.' },
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
    partDatasheets: {
      type: 'array',
      description: 'map of each active/non-trivial part (ICs, SSRs, optos, LDOs, TVS, USB-protection — anything with a datasheet in docs/) to its authoritative PDF, built from the schematic MPN/Value/LCSC fields matched to the docs/ filenames. This is the ONLY authority on which PDF backs which part.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refdes: { type: 'string', description: 'refdes(es) using this part, e.g. "K2, K4" or "U3"' },
          mpn: { type: 'string', description: 'MPN / Value as it appears in the schematic, e.g. GAQY212GS' },
          lcsc: { type: 'string', description: 'LCSC code if present, else "none"' },
          datasheetFile: { type: 'string', description: 'exact path under docs/ of the matching PDF, or "MISSING" if no docs/ file matches' },
        },
        required: ['refdes', 'mpn', 'lcsc', 'datasheetFile'],
      },
    },
  },
  required: ['repoRoot', 'components', 'nets', 'partDatasheets'],
}
const setup = await agent(
  `Set up ground truth for a pre-fab verification. Run these shell commands:\n` +
    `  REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\n` +
    `  rm -f "$REPO/prefab-report.html"\n` + // delete the stale report up front: a failed run leaves NO report, not a misleading old one
    `  mkdir -p /tmp/prefab\n` +
    `  kicad-cli sch export netlist "$REPO/kicad/doorbell.kicad_sch" -o /tmp/prefab/doorbell.net\n` +
    `  kicad-cli sch export python-bom "$REPO/kicad/doorbell.kicad_sch" -o /tmp/prefab/doorbell-bom.xml || true\n` +
    `  ls "$REPO/docs/"\n` +
    `Confirm /tmp/prefab/doorbell.net exists (and that any previous prefab-report.html is now deleted). Return the repo root ($REPO), the component count, and the net count. ` +
    `ALSO build partDatasheets: list the active/non-trivial parts from the schematic (read the MPN/Value/Datasheet/LCSC fields in $REPO/kicad/doorbell.kicad_sch — ICs, SSRs, optocouplers, the LDOs, the bus TVS, USB protection) and match each to its PDF in $REPO/docs/ by part number. Use "MISSING" if no docs/ file matches. Do NOT analyze the design or judge any datasheet contents — just produce the artifacts and the part→PDF map.`,
  { label: 'export-netlist', phase: 'Ground truth', schema: SETUP },
)
const REPO = setup.repoRoot
const DATASHEET_MAP =
  `AUTHORITATIVE PART → DATASHEET MAP (the ONLY source for which PDF backs which part; the manufacturer is whatever that PDF prints, not what the part number resembles):\n` +
  setup.partDatasheets.map((p) => `- ${p.refdes}: ${p.mpn} (LCSC ${p.lcsc}) → ${p.datasheetFile}`).join('\n')
const BLIND = mkBlind(REPO) + '\n\n' + DATASHEET_MAP

// Non-blind ANSWER KEY — runs concurrently with the blind derivation; the blind agents never see it.
const claimsP = agent(
  `You hold the ANSWER KEY for a pre-fab review (you are NOT blind — read whatever you need). Read ${REPO}/DESIGN.md, ${REPO}/REQUIREMENTS.md, ${REPO}/VERIFICATION.md and the sim tests under ${REPO}/sim/test/. For each verification block below, extract the design’s stated CLAIM (expected behaviour + any specific numbers) and the requirement IDs it maps to:\n` +
    BLOCKS.map((b) => '- ' + b.title).join('\n') +
    `\nReturn one claim per block.`,
  { label: 'claims', phase: 'Claims', schema: CLAIMS },
)

// Non-blind COVERAGE audit — runs concurrently with the blind derivation. Asks what the block list
// does NOT examine, so a missing dimension becomes an explicit finding instead of a silent blind spot.
const coverageP = agent(
  `You audit the COVERAGE of a pre-fab hardware verification — you are NOT blind, read whatever you need. ` +
    `The verification consists of EXACTLY these blocks, each deriving one question from primary sources:\n` +
    BLOCKS.map((b) => '- ' + b.title).join('\n') +
    `\n\nRead ${REPO}/REQUIREMENTS.md, ${REPO}/DESIGN.md and the schematic ${REPO}/kicad/doorbell.kicad_sch (for the active-IC / part list). Then answer two questions:\n` +
    `1) FAILURE-DIMENSION GAPS — across these axes: DC operating point, abs-max, connectivity/pinout, polarity, AC/dynamic behaviour, NOISE / PSRR / supply integrity, thermal, timing/jitter, EMI/coupling, tolerance/worst-case corner, MCU GPIO drive budget / fan-out (per-pin AND aggregate source/sink current, drive-strength, one pin driving multiple loads) — which dimensions are NOT examined by ANY block above? For each active IC and each performance-bearing subsystem, ask specifically: is there a block that checks it MEETS ITS PERFORMANCE SPEC, not merely that it is connected and within ratings? Name each uncovered dimension, why nothing catches it, and the block that should own it.\n` +
    `2) UNSPECIFIED FUNCTIONS — which subsystems have a FUNCTION (e.g. produce/receive audio) but NO numeric REQUIREMENT to verify against (no noise floor, SNR, accuracy, or margin number in REQUIREMENTS.md)? A function with no measurable requirement is a verification blind spot; propose the measurable requirement that should be added.\n` +
    `Be concrete — cite refdes and REQ IDs. Do NOT edit any files.`,
  { label: 'coverage-audit', phase: 'Coverage audit', schema: COVERAGE, effort: 'high' },
)

// Per-block: blind derive -> adversarial refute (pipelined, no barrier between blocks).
const results = await pipeline(
  BLOCKS,
  (b) =>
    agent(`${BLIND}\n\nQUESTION (${b.title}):\n${b.q}`, {
      label: `derive:${b.key}`,
      phase: 'Blind derive',
      schema: FINDING,
      effort: b.high ? 'high' : undefined, // high-stakes blocks get more reasoning (previously dead metadata)
    }),
  (f, b) =>
    agent(
      `${BLIND}\n\nQUESTION (${b.title}):\n${b.q}\n\n` +
        `A first independent analyst derived this:\n${JSON.stringify(f)}\n\n` +
        `Independently RE-DERIVE from the primary sources and ADVERSARIALLY try to break it. Look for BOTH failure kinds:\n` +
        `(a) a hard BREAK — an operating point, single fault, tolerance corner, pinout swap, or polarity error where the design stops working or exceeds an abs-max rating; AND\n` +
        `(b) a DEGRADATION — a disturbance / noise-coupling / insufficient-rejection / tolerance-stack mode where every part is connected and within abs-max yet the circuit MISSES A PERFORMANCE NUMBER (noise floor, SNR, level, accuracy, settling, margin). "Works but badly" still counts as broken.\n` +
        `Also AUDIT THE FIRST ANALYST'S SOURCES: open each docs/ PDF listed in their \`sources\`, confirm every rating they used actually appears at the stated locator, and confirm each \`manufacturerAsPrinted\` matches the brand printed on that PDF. A rating that cannot be located in docs/, a brand that does not match the cited file, or a number that looks recalled-from-memory rather than read is a finding even if the value looks plausible — set sourceVerified=false and describe it in sourceProblems.\n` +
        `Default to skepticism. Report whether you broke it (either kind), whether the sources check out, and where you agree.`,
      { label: `refute:${b.key}`, phase: 'Adversarial refute', schema: REFUTE, effort: b.high ? 'high' : undefined },
    ).then((r) => ({ block: b.title, key: b.key, high: !!b.high, finding: f, refute: r })),
)

const claims = await claimsP
const coverage = await coverageP

phase('Gate report')
const findings = results.filter(Boolean)
const gate = await agent(
  `You are the PRE-FAB GATE. Compare each blind finding (and its adversarial refutation) against the design’s own CLAIMS, weigh the verification-coverage audit, and decide whether the board is safe to fabricate.\n\n` +
    `DESIGN CLAIMS (answer key):\n${JSON.stringify(claims.claims, null, 2)}\n\n` +
    `BLIND FINDINGS + REFUTATIONS:\n${JSON.stringify(findings, null, 2)}\n\n` +
    `VERIFICATION-COVERAGE AUDIT (failure dimensions / functions no block owns):\n${JSON.stringify(coverage, null, 2)}\n\n` +
    `Classify each issue: BLOCKERS must be fixed before ordering (give the specific schematic/value fix + REQ/DESIGN ref); WARNINGS are risks or items only a bench test can settle; CORROBORATED are claims a blind agent independently reproduced. ` +
    `Weight any divergence between a blind finding and the claim, and any blocker-severity refutation, heavily. ` +
    `SOURCE INTEGRITY: any block whose refutation set sourceVerified=false (a rating not traceable to a docs/ PDF, a manufacturer that does not match the cited datasheet, or a number that looks recalled-from-memory) is UNTRUSTWORTHY regardless of how plausible its answer is — surface it as at least a WARNING (a blocker if the unverified rating is load-bearing for a GO), because a right-by-luck answer from the wrong datasheet will not survive a clone with different specs. ` +
    `Treat the coverage audit as first-class: a blocker-severity uncoveredDimension (a performance dimension NOTHING checks) is itself a NO-GO-class risk — escalate it to a blocker or warning, do not let it pass silently because no block raised it. ` +
    `Populate blindSpots with every failure dimension this review did NOT actually examine — fold in the coverage audit’s uncoveredDimensions AND anything a blind finding marked "undetermined". A GO/GO-WITH-FIXES verdict is conditional on exactly this list, so it must be honest and complete rather than empty. ` +
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
    `VERIFICATION-COVERAGE AUDIT (dimensions / functions no block owns):\n${JSON.stringify(coverage, null, 2)}\n\n` +
    `Layout:\n` +
    `1. Header: title "Klingel V4 — pre-fab blind verification" + the generation timestamp (run \`date\` to get it).\n` +
    `2. A prominent verdict banner colored by verdict (GO = green, GO-WITH-FIXES = amber, NO-GO = red) showing the summary and the top-3 fixes.\n` +
    `3. Blockers as cards: block, issue, fix, ref.\n` +
    `4. Warnings section.\n` +
    `5. A full per-block table — one row per block, columns: Block | Severity (colored badge: blocker = red, warning = amber, none = green; take the worse of the finding severity and any refute that broke it) | Design claim | Blind finding (derived + numbers + concern) | Sources (render each finding's sources[] as file · locator · manufacturerAsPrinted · quotedSpec in monospace; if a refute set sourceVerified=false, show a red "SOURCE UNVERIFIED" badge with its sourceProblems text) | Adversarial refute (broke? + failureMode + agreement). Match claims to findings by block title.\n` +
    `6. Corroborated list.\n` +
    `7. A "Coverage & blind spots" section that states what this verdict is NOT evidence about: first render the gate's blindSpots (dimension + why) as a prominent callout; then the coverage audit's uncoveredDimensions as a table (Dimension | Why | Suggested block | Severity badge) and unspecifiedFunctions as a table (Subsystem | Function lacking a spec | Suggested requirement).\n` +
    `Make it legible: system font stack, a max-width container, subtle borders, a sticky table header, monospace for component/net/number tokens. After writing, confirm the absolute file path.`,
  { label: 'render-html', phase: 'HTML report' },
)

log(`Report written to ${OUT} — verdict: ${gate.verdict} (${gate.blockers.length} blockers, ${gate.warnings.length} warnings, ${coverage.uncoveredDimensions.length} coverage gaps, ${gate.blindSpots.length} named blind spots)`)
return { report: OUT, verdict: gate.verdict, blockers: gate.blockers.length, warnings: gate.warnings.length, coverageGaps: coverage.uncoveredDimensions.length, blindSpots: gate.blindSpots.length }
