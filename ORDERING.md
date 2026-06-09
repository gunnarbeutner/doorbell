# Ordering Klingel V4 from JLCPCB (one assembled board)

Goal: get **one assembled board** via JLCPCB **Economic PCBA**. The board is ~52 × 58 mm,
**4-layer**, all parts on the **top side**; J1 (USB-C) and J2 (6-way screw terminal) are
through-hole but **assembled by JLCPCB** (THT assembly — nothing is hand-soldered). Economic
PCBA batch-panels small boards for us, so we don't supply a panel — but the bottom edge
carries the USB-C (J1, overhangs 3.1 mm) **and** U1's PCB antenna (flush on the edge), so
confirm JLCPCB's panel/depanel clears them (see the gates below).

> Run `./build.sh all-route` first to (re)generate the fab files in `kicad/fab/` — the
> committed gerbers/BOM/CPL are build outputs and may lag the design scripts.

## Files to upload

| Step | File |
|------|------|
| Gerbers | `kicad/fab/doorbell-jlcpcb.zip` (incl. the IPC-356 netlist for the E-test) |
| BOM | `kicad/fab/doorbell-bom-jlcpcb.csv` |
| Placement (CPL) | `kicad/fab/doorbell-cpl.csv` |

## The selections

- **PCB Type:** `Single PCB` (different designs in panel = 1)
- **Layers:** 4 (should auto-detect from the gerbers)
- **PCB Qty:** `5` — the minimum; you'll get 5 boards, assemble fewer
- ☑ **Confirm Production file** — JLCPCB prepares the manufacturing file (incl. the rails they
  add for assembly) and emails it for your approval. **Confirm within 48 h** or it auto-proceeds.
- **PCB Assembly:** ON
  - **Assembly side:** Top only (the board has no bottom-side parts)
  - **PCBA Type:** **Economic** if the quote allows it — **verify part eligibility at order
    time**: the BOM was originally curated to be Economic-eligible, but U1 (C6-WROOM-1,
    C5366877), U3 (ES8311, C962342), T1 (SM-LP-5001, C7503474) and SW3–SW5 (CAS-220TB1,
    C2921541) postdate that pass. If any line is Standard-only, the $25/side setup applies —
    decide then whether to proceed or substitute.
  - **Stock check:** also confirm LCSC stock on the less-common lines — the four above plus
    K1–K3 (G6K-2F-Y DC4.5, C397193), J1 (USB4085, C7095263), J2 (DB125-3.5-6P, C5290323).
  - **Through-hole parts:** J1 and J2 are in the CPL/BOM and assembled by JLCPCB; confirm THT
    assembly is included when JLCPCB reviews/quotes the order.
  - **Assembly Qty:** `2` — assemble one + a spare. The setup/part fees are already paid, so
    the second board is nearly free and cheap insurance against a dud.
- ☑ **Confirm Parts Placement** — JLCPCB checks rotation/polarity against their library and
  emails a placement preview. **Confirm within 72 h.**
- ☑ **Depanel boards & edge rail before delivery** — you get the individual boards freed from
  the frame (required anyway: the USB-C and antenna must be clear of the rails to work).

## ⚠️ The two review gates — don't rubber-stamp these

### 1. Production file (48 h window)

Economic has **no ≥70 mm / edge-rail requirement**; JLCPCB batch-panels small boards itself.
If it prepares a production file / panel, check before approving that **no break-tab or
mousebite lands on**:

- **bottom edge** — J1 (USB-C, overhangs the edge 3.1 mm) and the **U1 antenna zone**
  (the WROOM-1 antenna is flush on this edge over a copper keepout; tabs/drill nubs there
  sit right at the antenna)
- **top edge** — J2 (6-way screw terminal, flush on the edge)
- **left edge** — the three slide switches (SW3–SW5) sit only ~1 mm inside this edge

A tab/cut on any of those → **reject and comment**. Small mousebite nubs elsewhere on the
edges are fine as long as they're clear of parts.

### 2. Parts placement (72 h window)

JLCPCB "corrects" to their library's orientation — usually right, occasionally wrong if their
pin-1 convention differs. Eyeball pin 1 / direction on the polarity-sensitive parts,
worst-consequence first:

| Part | Check | If wrong |
|------|-------|----------|
| **U1** ESP32-C6-WROOM-1-N8 | pin 1 / rotation | dead board |
| **U2** SGM2212 LDO (SOT-223) | orientation | no 3V3, or damage |
| **U3** ES8311 codec (QFN-20, 0.4 mm pitch) | pin-1 dot | codec dead / damage |
| **D4** SS14 (VBUS Schottky) | band direction | blocks VBUS → board dead |
| **D7, D8, D9** 1N4148W (opto clamps) | band — must be **anti-parallel** to the opto LED (band toward the SW side / LED anode net) | all bell/session sense dead — a silent failure until bench test; scrutinise these three hardest |
| **D1, D2, D3** 1N4148W (relay flybacks) | band direction | shorts the relay drive |
| **D5** SRV05-4 (USB ESD) | orientation | wrong clamp / damage |
| **Q1, Q2, Q3** 2N7002 | SOT-23 G/S/D | relay drive dead |
| **OK1, OK2, OK3** LTV-217 optos | pin 1 | sense channels dead |
| **K1, K2, K3** G6K-2F-Y relays | orientation | contacts swapped → opener/chime logic wrong |
| **T1** SM-LP-5001 | pin 1 / winding A vs B | bus and codec windings swapped → codec sits on the bus side, isolation defeated |
| **D6** power LED | anode/cathode | just won't light (harmless) |
| **SW3, SW4, SW5** CAS-220TB1 | present + seated | a 180° rotation is harmless (polarity selector — COM stays on the centre pins) |

## Cost expectations

The PCB itself is the *small* line. On Economic PCBA there's no $25/side setup; the cost is
dominated by the per-type **loading/feeder fee** on each unique part (this BOM has ~30 unique
lines), the parts themselves, and the (small) assembly + stencil cost. Rough budget:
**€60–110 all-in** on Economic; more if any part forces Standard PCBA ($25/side). You only pay
assembly on the 1–2 boards you choose to populate.

## Fallback: if JLCPCB's panel mishandles those edges

Reject the production file with a comment describing which edge the tab/cut violates — JLCPCB
re-prepares it.

## Why this route (one-liner)

Economic PCBA assembles the whole board — SMT, the THT connectors, no setup fee, no forced
≥70×70 rail panel — while JLCPCB handles fab and panelization of the small board. Watch the
J1/antenna (bottom), J2 (top) and switch (left) edges at the Confirm gates, and triple-check
D7–D9 polarity at the placement gate.
