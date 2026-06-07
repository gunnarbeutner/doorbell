# Ordering Klingel V4 from JLCPCB (one assembled board)

Goal: get **one assembled board**, with JLCPCB doing the fab, the assembly, **and** the
panelization (this board has connectors/parts on all four edges, so we let their engineers add
the rails and we review their work — rather than supplying our own panel).

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
  - **PCBA Type:** **Standard** (Economic won't place the ESP32 module / relays)
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
Check JLCPCB's panelization before approving:
- Rails were added so the panel is **≥ 70 × 70 mm**.
- **No break-tab or V-cut lands on a part on these edges:**
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
| **U1** ESP32-C3-MINI-1 | pin 1 / rotation | dead |
| **D5** SRV05-4 | orientation | wrong clamp / damage |
| **D1, D2** 1N4148W (flyback) | band direction | shorts the relay drive |
| **D3** LED | anode/cathode | just won't light (harmless) |
| **Q1, Q2** 2N7002 | SOT-23 G/S/D | relay drive dead |
| **OK1, OK2** optos | pin 1 | bell-sense dead |
| **K1, K2** relays | orientation | wrong contacts |

## Cost expectations

The PCB itself is the *small* line. For one assembled, 4-layer board the cost is dominated by:
- one-time assembly **setup** + stencil, and
- a per-type **loading fee (~$3)** on each of the ~8 "extended" parts (ESP32, relays, LDO, ESD
  array, USB-C, terminal, buttons, optos), plus the parts themselves.

Budget roughly **€60–100 all-in** for the run. Quantity 1 doesn't exist anywhere — 5 boards is the
floor — but you only pay assembly on the 1–2 you choose to populate.

## Fallback: if JLCPCB's panel mishandles those edges

We have a verified, overhang-aware panel as backup — but its break-tabs currently land on J2/D4,
so it needs a tab-placement rework first. If JLCPCB's production file is bad on the J1/J2/D4/antenna
edges, ask me to finish the hand-placed-tab version of `doorbell-panel-jlcpcb.zip` and switch the
order to **Panel by Customer** with that file.

## Why this route (one-liner)

Standard PCBA forces a ≥70×70 panel; the board is congested on every edge, so letting JLCPCB's
engineers place the break-tabs (and reviewing their work via the two Confirm gates + depanel) is
lower-risk than hand-fitting our own panel.
