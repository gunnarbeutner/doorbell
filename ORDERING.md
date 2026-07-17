# Ordering the doorbell controller from JLCPCB

Goal: get **one assembled board** via JLCPCB **Standard PCBA** (the current BOM is not eligible
for Economic). The board is ~64 × 59 mm, **4-layer**, all parts on the **top side**; J2 (5-way
screw terminal) is through-hole and assembled by JLCPCB. J1 is the SMT JST-SH power/USB service
connector. The board is under JLCPCB's assembly minimum, so order it as **"Panel by JLCPCB"**
(edge rails added by them); confirm the panel/rails/depanel clear J2 (see the gates below). U1 is an
**ESP32-S3-WROOM-1U-N16R8** —
a **u.FL external antenna** module, so there is no PCB-antenna edge keepout to protect (route the
antenna lead out of the enclosure instead).

> Run `./build.sh` first to verify the design and re-export the fab files in `fab/` — the committed
> gerbers/BOM/CPL are build outputs and may lag the schematic.

## Mechanical fit gate (V4.1 seating passed, Talk actuation failed; current V4.2 still open)

**MECH-1 seating passed on V4.1, but MECH-1a did not:** the assembled PCB fits the original WF26
enclosure, seats on the bosses, clears the closed lid, and aligns the speaker and wire entry. The
door control works, but the housing's Talk actuator hits the fitted USB-C connector before SW4 fully
engages. The current V4.2 candidate removes that connector. The earlier printed fit does not qualify
HEAD: repeat MECH-1/MECH-1a on a current export before ordering, using the actual J1 mating plug and
cable.

Repeat this gate before ordering only if a revision changes the board outline, mounting pattern,
switch/speaker/connector placement, or maximum component height. `./build.sh` (or
`./build.sh step`) exports `fab/doorbell.step`; print it and check it against the original enclosure:

- **Board fits the housing (MECH-1).** Outline clears the housing walls/posts; the mounting holes
  (H1–H2) line up with the enclosure's bosses; nothing tall (U1, the latch relay K5, the
  electrolytics, the screw terminal) fouls a rib or the lid.
- **Connector access.** Fully seat the actual JST-SH mating plug and intended cable in J1 with the
  lid closed. Check cable exit, bend radius and strain as well as direct connector clearance; then
  confirm the Talk actuator still travels fully. J2's wire mouths must remain reachable to land the
  five bus wires once installed.
- **Switches fit + actuate (MECH-1a) — the point of the test.** The STEP model **deliberately omits
  SW3/SW4** (the `STEP_Exclude` field; see `tools/step_exclude.py`) — the door-release and talk
  front-panel buttons (`SPPJ322300`) — so you fit-test the printed board against the **real**
  switches and the housing's button apertures. Confirm each plunger tip lands under its aperture and
  that pressing the housing button fully actuates the switch (this is also what makes the manual
  buttons work unpowered, MODE-1a). SW1/SW2 are just the BOOT/EN commissioning tactiles — not
  enclosure-critical.

If anything fouls or misaligns, fix it in the PCB and re-print before committing the order. The
print is also a free sanity check on the 3D-model alignment (parts should sit min-z = 0 on the
board face).

## Files to upload

| Step | File |
|------|------|
| Gerbers | `fab/doorbell-jlcpcb.zip` (incl. the IPC-356 netlist for the E-test) |
| BOM | `fab/doorbell-bom-jlcpcb.csv` |
| Placement (CPL) | `fab/doorbell-cpl.csv` |

## The selections

- **PCB Type:** `Single PCB` (different designs in panel = 1)
- **Layers:** 4 (should auto-detect from the gerbers)
- **PCB Qty:** `5` — the minimum; you'll get 5 boards, assemble fewer
- ☑ **Confirm Production file** — JLCPCB prepares the manufacturing file (incl. the rails they
  add for assembly) and emails it for your approval. **Confirm within 48 h** or it auto-proceeds.
- **PCB Assembly:** ON
  - **Assembly side:** Top only (the board has no bottom-side parts)
  - **PCBA Type:** **Standard** — the current BOM is not Economic-eligible. Standard carries a
    per-side setup fee; the specialised parts (RF module, codec, LDO, PhotoMOS SSRs, latch relay,
    JST-SH service connector and bus terminal) may add per-type loading fees.
  - **Stock check:** confirm LCSC stock on the less-common Extended lines (the RF module, codec,
    LDO, SSRs, latch relay, JST-SH connector, screw terminal and door switches) against the current
    `fab/doorbell-bom-jlcpcb.csv` and the live JLCPCB import/quote. Do not carry a previous quote's
    stock or Basic/Extended classification forward.
  - **Through-hole parts:** J2 is assembled by JLCPCB; confirm THT
    assembly is included when JLCPCB reviews/quotes the order.
  - **Assembly Qty:** `2` — assemble one + a spare. The setup/part fees are already paid, so
    the second board is nearly free and cheap insurance against a dud.
- ☑ **Confirm Parts Placement** — JLCPCB checks rotation/polarity against their library and
  emails a placement preview. **Confirm within 72 h.**
- ☑ **Depanel boards & edge rail before delivery** — you get the individual boards freed from
  the frame (required anyway: the screw terminal must be clear of the rails).

## ⚠️ The two review gates — don't rubber-stamp these

### 1. Production file (48 h window)

The ~64 × 59 mm board is under the Standard-assembly minimum, so JLCPCB panels it with edge
rails ("Panel by JLCPCB"). When the production file arrives, check before approving that no rail,
break-tab or mousebite lands at **J2**; its wire mouths must stay clear.

Confirm the default solder-jumper state survived the production-file conversion: **JP1 and JP3 are
bridged in copper; JP2 is open**. They are PCB features excluded from the BOM/CPL, so the assembler
will not populate or correct them. JP3 enables the 200 kΩ TX precharge path and is cut only for a
diagnostic A/B test.

A tab/cut at J2 → **reject and comment**, and JLCPCB re-prepares it. Small mousebite nubs
elsewhere on the edges are fine as long as they're clear of parts. (No PCB-antenna edge to worry
about — the u.FL module's antenna is external.)

### 2. Parts placement (72 h window)

JLCPCB "corrects" to their library's orientation — usually right, occasionally wrong if their
pin-1 convention differs. Eyeball pin 1 / band direction on the polarity-sensitive parts against
the schematic, **worst-consequence first**. Identify the refdes from the BOM; the classes to
scrutinise:

| Class | Why it matters | If wrong |
|------|-------|----------|
| **Opto reverse-clamps D8/D9** (1N4148W anti-parallel across OC1/OC2 LEDs) | band/cathode must point to each opto LED's anode / bus-line net | **both bell-sense channels dead** — a silent failure until bench test; **scrutinise hardest** |
| **MCU** (ESP32-S3-WROOM-1U-N16R8) | pin 1 / rotation | dead board |
| **LDOs U2/U4** (SGM2212-3.3 and LP5907MFX-3.3, SOT-23-5) | pin 1 / rotation; do not treat the two pinouts as interchangeable | no 3V3/AVDD, or damage |
| **Codec** (ES8311, QFN-20, 0.4 mm pitch) | pin-1 dot | codec dead / damage |
| **USB ESD** (TPD2S017) | pin-1 — channels are in series with D± | USB dead / wrong clamp |
| **VBUS Schottky / TVS** (SS14 series, SMF5.0A clamp) | band direction | blocks VBUS, or shorts/leaves it unclamped |
| **PhotoMOS SSRs K1/K2/K3/K4/K6** | K1 GAQW212GS and K2 GAQY212GS are NO; K3/K4/K6 GAQY412EH are **NC**; confirm pin 1 and part value at every ref | a swapped NO/NC breaks the gong, door or P4-isolation fail-safe |
| **Physical Talk switch SW4 + R42/R43** | confirm the SPPJ322300 orientation/pin numbers: released 2↔3 grounds `K1_LED_RET`; pressed 2↔1 grounds `PTT_SW_N`, while 5↔4 makes the passive P3 Talk path. R42 is 10 kΩ and R43 is 1 kΩ | reversed switch action can disable K1 at rest, lose passive Talk, or invert/defeat physical-PTT sensing |
| **Latch relay K5 + flyback D1** | K5 is G6K-2F-Y DC12; confirm pin 1 and both pole mappings. D1 is 1N4004W with A4 top code; its cathode band faces `K5_LATCH` | no seal-in/sense, a defeated K6 interlock, or wrong flyback |
| **Door FETs Q3/Q4** | each is an AO3400A SOT-23 (1=G, 2=S, 3=D); reconcile rotation separately | door break-before-make or watchdog dead |
| **Codec clamps D13/D14/D16/D17 and AVDD block D18** | tiny X3-DFN LMBR01S30ST5G; pin 1 is cathode — match each pin-1 mark to its schematic net | codec over/under-rail protection or AVDD feed defeated |
| **Crossover C19** | EEEFK1H220P is polarised: pin 1 (+) faces `CHIME_POS`/P4 and the negative stripe faces P5 | passive gong/listen path degraded or capacitor overstressed |
| **Service connector J1** | SM04B-SRSS-TB pin order and side-entry orientation; compare the placement preview with the real mating-plug approach | reversed power/USB wiring or an inaccessible connector |
| **Power LED** | anode/cathode | just won't light (harmless) |

## Cost expectations

The PCB itself is the *small* line. On Standard PCBA the setup, loading/feeder fees for Extended
parts, assembly, stencil and parts dominate. Treat the live import/quote as authoritative for prices
and classifications; they change independently of the source tree. You only pay assembly on the
1–2 boards you choose to populate.

## Why this route (one-liner)

Standard PCBA assembles the whole board — SMT and the THT connectors — with JLCPCB handling fab
and the edge-rail panel of the small board. Watch the J1 and J2 edges at the Confirm gates, and
triple-check the opto-clamp polarity at the placement gate.
