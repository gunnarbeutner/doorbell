# Ordering Klingel V4 from JLCPCB (one assembled board)

Goal: get **one assembled board** via JLCPCB **Standard PCBA** (the current BOM is not eligible
for Economic). The board is ~64 × 59 mm, **4-layer**, all parts on the **top side**; J2 (5-way
screw terminal) is through-hole and J1 (USB-C) has THT shell stakes — both **assembled by JLCPCB**
(THT assembly — nothing is hand-soldered). The board is under JLCPCB's assembly minimum, so
order it as **"Panel by JLCPCB"** (edge rails added by them) — the edge connectors (J1 USB-C,
shell protrudes; J2 screw terminal) sit flush on the outline, so confirm the panel/rails/depanel
clear them (see the gates below). U1 is an **ESP32-S3-WROOM-1U-N16R8** —
a **u.FL external antenna** module, so there is no PCB-antenna edge keepout to protect (route the
antenna lead out of the enclosure instead).

> Run `./build.sh` first to verify the design and re-export the fab files in `fab/` — the committed
> gerbers/BOM/CPL are build outputs and may lag the schematic.

## Mechanical fit gate (physically passed on V4.1)

**MECH-1 and MECH-1a have passed:** the assembled V4.1 PCB fits and operates in the original WF26
enclosure. The board seats on the bosses, the populated-board height clears the closed lid, the
speaker and wire entry align, and both original housing buttons actuate the board switches. This is
a real-hardware fit result, not an inference from the STEP model.

Repeat this gate before ordering only if a revision changes the board outline, mounting pattern,
switch/speaker/connector placement, or maximum component height. `./build.sh` (or
`./build.sh step`) exports `fab/doorbell.step`; print it and check it against the original enclosure:

- **Board fits the housing (MECH-1).** Outline clears the housing walls/posts; the mounting holes
  (H1–H5) line up with the enclosure's bosses; nothing tall (U1, the latch relay K5, the
  electrolytics, the screw terminal) fouls a rib or the lid.
- **Connector access.** J1 (USB-C, shell protrudes past the edge) reaches its wall aperture, and
  J2's wire mouths are reachable to land the 5 bus wires once installed.
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
  - **PCBA Type:** **Standard** — the current BOM is not Economic-eligible. Standard carries the
    $25/side setup; the specialised parts (RF module, codec, LDO, PhotoMOS SSRs, latch relay,
    USB-C jack, bus terminal) are Extended and add per-type loading fees on top. The
    free-vs-fee breakdown is in `JLCPCB-BASIC-PARTS.md`.
  - **Stock check:** confirm LCSC stock on the less-common Extended lines (the RF module, codec,
    LDO, SSRs, latch relay, USB-C jack, screw terminal, door switches) against the current
    `fab/doorbell-bom-jlcpcb.csv` — `JLCPCB-BASIC-PARTS.md` flags the low-stock ones.
  - **Through-hole parts:** J2 (and J1's shell stakes) are assembled by JLCPCB; confirm THT
    assembly is included when JLCPCB reviews/quotes the order.
  - **Assembly Qty:** `2` — assemble one + a spare. The setup/part fees are already paid, so
    the second board is nearly free and cheap insurance against a dud.
- ☑ **Confirm Parts Placement** — JLCPCB checks rotation/polarity against their library and
  emails a placement preview. **Confirm within 72 h.**
- ☑ **Depanel boards & edge rail before delivery** — you get the individual boards freed from
  the frame (required anyway: the USB-C and screw terminal must be clear of the rails).

## ⚠️ The two review gates — don't rubber-stamp these

### 1. Production file (48 h window)

The ~64 × 59 mm board is under the Standard-assembly minimum, so JLCPCB panels it with edge
rails ("Panel by JLCPCB"). When the production file arrives, check before approving that **no
rail, break-tab or mousebite lands on the edge connectors** — wherever they sit on the current
outline:

- **J1** (USB-C) — the shell protrudes past the board edge; a tab there fouls the connector.
- **J2** (5-way screw terminal) — flush on its edge; the wire mouths must stay clear.

A tab/cut on either → **reject and comment**, and JLCPCB re-prepares it. Small mousebite nubs
elsewhere on the edges are fine as long as they're clear of parts. (No PCB-antenna edge to worry
about — the u.FL module's antenna is external.)

### 2. Parts placement (72 h window)

JLCPCB "corrects" to their library's orientation — usually right, occasionally wrong if their
pin-1 convention differs. Eyeball pin 1 / band direction on the polarity-sensitive parts against
the schematic, **worst-consequence first**. Identify the refdes from the BOM; the classes to
scrutinise:

| Class | Why it matters | If wrong |
|------|-------|----------|
| **Opto reverse-clamps** (1N4148W anti-parallel across the bell-sense opto LEDs) | band must point to the LED-anode / bus-line net | **both bell-sense channels dead** — a silent failure until bench test; **scrutinise hardest** |
| **MCU** (ESP32-S3-WROOM-1U-N16R8) | pin 1 / rotation | dead board |
| **LDO** (SGM2212, SOT-223) | orientation | no 3V3, or damage |
| **Codec** (ES8311, QFN-20, 0.4 mm pitch) | pin-1 dot | codec dead / damage |
| **USB ESD** (TPD2S017) | pin-1 — channels are in series with D± | USB dead / wrong clamp |
| **VBUS Schottky / TVS** (SS14 series, SMF5.0A clamp) | band direction | blocks VBUS, or shorts/leaves it unclamped |
| **PhotoMOS SSRs** (talk/door NO; chime-mute / seal-in-break **NC**) | the NC parts must stay **1-Form-B** | a swapped NO/NC breaks the gong/door fail-safe |
| **Latch relay** (HJR4102) + its flyback (1N4148W) | orientation / band | seal-in or flyback wrong |
| **Dual MOSFET** (2N7002DW) | SOT-363 pinout | door break-before-make / watchdog dead |
| **Power LED** | anode/cathode | just won't light (harmless) |

## Cost expectations

The PCB itself is the *small* line. On Standard PCBA the cost is the **$25/side setup**, the
per-type **loading/feeder fee** on each unique **Extended** part (~$3 each — see
`JLCPCB-BASIC-PARTS.md` for the count), the parts themselves, and the (small) assembly + stencil
cost. You only pay assembly on the 1–2 boards you choose to populate.

## Why this route (one-liner)

Standard PCBA assembles the whole board — SMT and the THT connectors — with JLCPCB handling fab
and the edge-rail panel of the small board. Watch the J1 and J2 edges at the Confirm gates, and
triple-check the opto-clamp polarity at the placement gate.
