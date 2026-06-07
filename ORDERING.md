# Ordering Klingel V4 from JLCPCB (one assembled board)

Goal: get **one assembled board** via JLCPCB **Economic PCBA**. Every part is Economic-eligible
(that's why U1 is the ESP32-C3-WROOM-02, **not** the Standard-only MINI-1), so there is **no
$25/side setup**. The board is small (~40.5 × 47.7 mm); Economic PCBA batch-panels small boards for
us, so we don't supply a panel — but the bottom USB-C (J1) and the left-edge antenna **overhang the
board edge**, so confirm JLCPCB's panel/depanel clears them (see the gate below). Our own KiKit
panel is kept only as a fallback.

> Run `./build.sh all-route` first to (re)generate the fab files in `kicad/fab/`.

## Files to upload (the SINGLE-board set, not the panel)

| Step | File |
|------|------|
| Gerbers | `kicad/fab/doorbell-jlcpcb.zip` (incl. the IPC-356 netlist for the E-test) |
| BOM | `kicad/fab/doorbell-bom-jlcpcb.csv` |
| Placement (CPL) | `kicad/fab/doorbell-cpl.csv` |

Do **not** upload `doorbell-panel-*` — that's our self-made panel, kept only as a fallback.

## The selections

- **PCB Type:** `Single PCB` (different designs in panel = 1)
- **Layers:** 4 (should auto-detect from the gerbers)
- **PCB Qty:** `5` — the minimum; you'll get 5 boards, assemble fewer
- ☑ **Confirm Production file** — JLCPCB prepares the manufacturing file (incl. the rails they
  add for assembly) and emails it for your approval. **Confirm within 48 h** or it auto-proceeds.
- **PCB Assembly:** ON
  - **Assembly side:** Top only
  - **PCBA Type:** **Economic** — all parts (WROOM-02 U1, G6K relays, THT J1/J2) are
    Economic-eligible, so no $25/side Standard setup. (Economic caps at 30 boards and needs 100%
    in-stock LCSC parts — both fine here. V-cut isn't offered on Economic; mousebites only if panelized.)
  - **Through-hole parts:** J1 (USB-C) and J2 (6-way terminal) are THT but **assembled by JLCPCB**
    (they're in the CPL/BOM; `HANDSOLDER` is empty) — **nothing is hand-soldered**. Confirm their
    through-hole assembly is included when JLCPCB reviews/quotes the order.
  - **Assembly Qty:** `2` — assemble one + a spare. The setup/part fees are already paid, so the
    second board is nearly free and cheap insurance against a dud.
- ☑ **Confirm Parts Placement** — JLCPCB checks rotation/polarity against their library and emails
  a placement preview. **Confirm within 72 h.**
- ☑ **Depanel boards & edge rail before delivery** — you get the individual boards freed from the
  frame (required anyway: the USB-C and antenna must be clear of the rails to work).

## ⚠️ The two review gates — don't rubber-stamp these

### 1. Production file (48 h window)
Economic has **no ≥70 mm / edge-rail requirement** (that was the Standard-PCBA rule); JLCPCB
batch-panels small boards itself. If it prepares a production file / panel, check before approving:
- **No break-tab or mousebite lands on a part on these edges:**
  - **bottom** — J1 (USB-C, overhangs the edge) and D4 (SS14 Schottky, near the edge)
  - **top** — J2 (6-way screw terminal, flush on the edge)
  - **left** — U1's antenna (overhangs the edge)
- A tab/cut on any of those → **reject and comment**, or fall back to our panel (see below).
- Small mousebite nubs on the board edges are fine as long as they're clear of parts.

### 2. Parts placement (72 h window)
JLCPCB "corrects" to their library's orientation — usually right, occasionally wrong if their
pin-1 differs. Eyeball pin 1 / direction on the polarity-sensitive parts, worst-consequence first:

| Part | Check | If wrong |
|------|-------|----------|
| **U2** SGM2212 LDO | pin 1 / GND-OUT-IN | no 3V3, or damage |
| **D4** SS14 (VBUS Schottky) | band direction | blocks VBUS → board dead |
| **U1** ESP32-C3-WROOM-02-N4 | pin 1 / rotation | dead |
| **D5** SRV05-4 | orientation | wrong clamp / damage |
| **D1, D2** 1N4148W (flyback) | band direction | shorts the relay drive |
| **D3** LED | anode/cathode | just won't light (harmless) |
| **Q1, Q2** 2N7002 | SOT-23 G/S/D | relay drive dead |
| **OK1, OK2** optos | pin 1 | bell-sense dead |
| **K1, K2** relays | orientation | wrong contacts |

## Cost expectations

The PCB itself is the *small* line. On **Economic PCBA there's no $25/side setup** (the whole reason
for the WROOM-02 swap). The cost is dominated by:
- a per-type **loading/feeder fee** on each unique part, plus the parts themselves, and
- the (small) Economic assembly + stencil cost.

Budget is **lower than the old Standard route** (no $25/side setup) — on the order of **€40–80
all-in**. You only pay assembly on the 1–2 boards you choose to populate.

## Fallback: if JLCPCB's panel mishandles those edges

We have a verified, overhang-aware panel as backup — but its break-tabs currently land on J2/D4,
so it needs a tab-placement rework first. If JLCPCB's production file is bad on the J1/J2/D4/antenna
edges, ask me to finish the hand-placed-tab version of `doorbell-panel-jlcpcb.zip` and switch the
order to **Panel by Customer** with that file.

## Why this route (one-liner)

Swapping U1 to the Economic-eligible ESP32-C3-WROOM-02 lets the whole board go **Economic PCBA** —
no $25/side setup and no forced ≥70×70 rail panel — while JLCPCB still handles fab, assembly and (if
needed) panelization of the small board. Watch the overhanging J1/antenna edges at the Confirm gates.
