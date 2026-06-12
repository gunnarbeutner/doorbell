# Doorbell V4 — code-generated KiCad project

## Build pipeline (everything regenerates from `doorbell_design.py`)

`doorbell_design.py` is the single source of truth (components, nets, footprints,
placement). Two generators consume it; `build.sh` orchestrates them:

```
./build.sh            # schematic + PCB (unrouted) + ERC + schematic PDF
./build.sh route      # finalize the PCB (planes/groups/thieving; fails if unrouted)
./build.sh fab        # Gerbers + drill + position + BOM -> kicad/fab/
./build.sh all-route  # schematic + PCB + route + fab (full run)
```

| Script | Interpreter | Output |
|--------|-------------|--------|
| `gen_schematic.py` | `.venv/bin/python` (kiutils) | `doorbell.kicad_sch` — ERC 0 errors |
| `gen_pcb.py` | KiCad bundled python (pcbnew) | `doorbell.kicad_pcb` — placed + netted, 0 DRC |
| `route.py` | KiCad bundled python (pcbnew) | finalizes the board (planes, groups, thieving); fails if any connection is unrouted |

The board is **100% hand-routed** in `gen_pcb.py` (there is no autorouter).
`route.py` fills the inner planes, adds groups and copper thieving, and FAILS the
build if any connection is left unrouted — missing copper is added in `gen_pcb.py`,
never invented by a tool. Re-running `gen_pcb.py` rebuilds the board from scratch,
so iterate as: edit `doorbell_design.py` → `./build.sh` → `./build.sh route`.

> The PCB uses the explicit compact floorplan in `gen_pcb.py` (`PCB_PLACE`): logic/USB in the
> lower-left, bus interface on the right; ~35.8×47.7 mm, 4-layer (F.Cu / +3V3 / GND / B.Cu).
> J1/J2/U1 sit flush on their board edges (`EDGE_FLUSH`); `check_pcb.py` gates the placement.

---

# Reference: scaffold + capture spec

Single-board redesign of the Klingel controller (ESP32-C3 + USB-C + on-board relay
drivers). See `../DESIGN.md` for the full rationale; this folder is the KiCad starting
point. **Carry the proven V3 analog path over verbatim** — do not re-tune the opto
front-end values (PC817/LTV-217, 5.1 kΩ limiter per opto = R_lim1/R_lim2, R_em = 1 kΩ shared emitter) or the relay contact arrangement.

## What's in here

| File | Status |
|------|--------|
| `doorbell.kicad_sch` | **Generated schematic** — 34 parts, all V4 nets. Loads in KiCad 10, **ERC: 0 errors**, 12 benign warnings (see below). |
| `gen_schematic.py` | The generator (uses `kiutils` in `../.venv`). Edit + re-run to regenerate the schematic. |
| `doorbell.pdf` | Rendered schematic (`kicad-cli sch export pdf`). |
| `doorbell.kicad_pro` | Project file (open this in KiCad 10). |
| `sym-lib-table` / `fp-lib-table` | Empty — all symbols/footprints come from global libs (Espressif `PCM_Espressif`, CDFER `PCM_JLCPCB-*`, stock KiCad). |

> **How the schematic was generated.** Hand-writing a `.kicad_sch` fought KiCad 10's exact
> format, so the generator uses **[`kiutils`](https://pypi.org/project/kiutils/)** (installed
> in `../.venv`), which serializes the correct format. It loads real library symbols (your
> installed Espressif `ESP32-C3-MINI-1`, CDFER JLCPCB parts with LCSC numbers, stock USB-C /
> relay / power), places them on a grid, and wires everything with **local net labels placed
> exactly on each pin** (connectivity is by label name, verified by ERC). It is electrically
> complete but **not laid out with wires** — open it in Eeschema and tidy/route as you like.
> The pin-coordinate transform (`abs = inst + (pinX, −pinY)`) and the relay/opto/ESP pin maps
> were all validated before generation.

### Regenerate / verify
```bash
.venv/bin/python kicad/gen_schematic.py                       # regenerate
kicad-cli sch erc kicad/doorbell.kicad_sch -o /tmp/erc.txt    # 0 errors expected
```
The 12 ERC **warnings** are all `pin_to_pin: Unspecified and {Passive, Bidirectional, Power input}` —
they come from library symbols (the SGM2212 LDO, the SRV05-4 ESD array, and the tactile buttons)
whose pins are typed *Unspecified*; harmless.

## Part mapping (symbol → footprint → LCSC)

| Ref (internal key) | Value | Symbol | Footprint | LCSC |
|-----|-------|--------|-----------|------|
| U1 | ESP32-C3-MINI-1 | `PCM_Espressif:ESP32-C3-MINI-1` | (from symbol) ¹ | C2838502 ² |
| U2 | SGM2212-3.3 (LDO) | `PCM_JLCPCB-Power:LDO, 3.3V, 1A` | `PCM_JLCPCB:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR` | C3294699 ² |
| J1 | USB-C 2.0 (GCT USB4085) | `Connector:USB_C_Receptacle_USB2.0_16P` | `Connector_USB:USB_C_Receptacle_GCT_USB4085` | C7095263 ² ³ |
| J2 | WF26 6-way screw terminal | `Connector_Generic:Conn_01x06` | `TerminalBlock_4Ucon:TerminalBlock_4Ucon_1x06_P3.50mm_Vertical` | C5290323 ² ³ |
| K1, K2 | Relay G6K-2F-Y, **4.5 V** coil | `Relay:G6K-2` ⁴ | `Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y` | C397193 ² |
| Q1, Q2 | 2N7002 (relay driver) | `PCM_JLCPCB-Transistors:NMOS,2N7002` | `PCM_JLCPCB:Q_SOT-23` | C8545 |
| D1, D2 | 1N4148W (relay flyback) | `PCM_JLCPCB-Diodes:Switching,1N4148W` | `PCM_JLCPCB:D_SOD-123` | C81598 |
| D4 (D_vbus) | SS14 (VBUS reverse-protect) | `PCM_JLCPCB-Diodes:Schottky,SS14` | `PCM_JLCPCB:D_SMA` | C2480 |
| D5 (D_esd) | SRV05-4 (USB D+/D− ESD) | `PCM_JLCPCB-Diode-Packages:Package, SRV05-4_C7420376` | `PCM_JLCPCB:SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BL-1` | C7420376 |
| OK1, OK2 (OC1/OC2) | LTV-217 (PC817, SMD) | `PCM_JLCPCB-Optocouplers:LTV-217-B-G` ⁵ | `PCM_JLCPCB:SOP-4_4.4x2.6mm_P1.27mm` | C115450 |
| R1, R2 (R_lim1, R_lim2) | 5.1 kΩ — opto LED limiters (one per opto) | `PCM_JLCPCB-Resistors:0603,5.1kΩ` | `PCM_JLCPCB:R_0603` | C23186 |
| R3 (R_em) | 1 kΩ — opto emitter (shared) | `PCM_JLCPCB-Resistors:0603,1kΩ` | `PCM_JLCPCB:R_0603` | C21190 |
| R4, R5 (R_g1/2) | 100 Ω — gate series | `PCM_JLCPCB-Resistors:0603,100Ω` | `PCM_JLCPCB:R_0603` | C22775 |
| R6, R7, R8, R9, R10 (R_pd1/2, R_en, R_boot, R_io8) | 10 kΩ — gate pull-downs, EN/BOOT/GPIO8 pull-ups | `PCM_JLCPCB-Resistors:0603,10kΩ` | `PCM_JLCPCB:R_0603` | C25804 |
| R11, R12 (R_cc1/2) | 5.1 kΩ — USB-C CC (Rd sink) | `PCM_JLCPCB-Resistors:0603,5.1kΩ` | `PCM_JLCPCB:R_0603` | C23186 |
| R13 (R_led) | 1 kΩ — power-LED series | `PCM_JLCPCB-Resistors:0603,1kΩ` | `PCM_JLCPCB:R_0603` | C21190 |
| C2, C3, C4 (C_in, C_3v3, C_out) | 10 µF — LDO in/out + 3V3 decoupling | `PCM_JLCPCB-Capacitors:0603,10uF` | `PCM_JLCPCB:C_0603` | C19702 |
| C5, C6 (C_en, C_dec) | 100 nF — EN cap + 3V3 decoupling | `PCM_JLCPCB-Capacitors:0603,100nF` | `PCM_JLCPCB:C_0603` | C14663 |
| D3 (LED_pwr) | power LED, **red** | `PCM_JLCPCB-Diodes:LED,0603,Red` | `PCM_JLCPCB:D_0603` | C2286 |
| SW1, SW2 (SW_boot, SW_en) | tactile button (BOOT / RST) | `PCM_JLCPCB-Connectors_Buttons:Tactile Button, 160gf, 12V, 50mA, 4.0mm` | `PCM_JLCPCB:SW_TS-1088-AR02016` | C720477 |

> No bulk electrolytic — the 470 µF was removed (the local LDO regulates the WiFi-TX burst); the
> 3V3 rail decouples with 10 µF×2 + 100 nF and the LDO output is 10 µF (not 22 µF).

¹ Uses your installed Espressif library symbol + footprint (official pads).
² Verify LCSC / JLCPCB stock at order time. ³ J1/J2 are through-hole but **JLCPCB-assembled**
(THT assembly) — **not hand-soldered**. ⁴ `G6K-2` is DPDT; the design uses **one Form C pole**
(COM = 3, NC = 2, NO = 4), with the second pole and the unused contact left No-Connect. The coil is
the **4.5 V (DC4.5)** variant — must-operate 3.6 V, clearing the post-Schottky ~4.5 V rail (see
`../DESIGN.md` review finding 2). ⁵ LTV-217 = JLCPCB-stocked 817-family SMD opto (PC817
equivalent); swap for `PC817S` for the exact V3 part.

## ESP32-C3-WROOM-02 pin usage (castellated pads)

| Pad | GPIO | Net | Role |
|-----|------|-----|------|
| 1 | 3V3 | +3V3 | supply |
| 9 + 19(EP) | GND | GND | supply + thermal |
| 2 | EN | EN | reset (R_en↑ + C_en) |
| 8 | IO9 | BOOT | strap (R_boot↑, SW_boot) |
| 7 | IO8 | GPIO8 | strap — 10 kΩ pull-up (R_io8), download-mode robustness |
| 13 | IO18 | USB_DM | USB D− |
| 14 | IO19 | USB_DP | USB D+ |
| 11 | IO20 | GATE1_DRV | K1 driver (door / ÖT) — IO20/U0RXD, high-Z at reset |
| 10 | IO10 | GATE2_DRV | K2 driver (chime) — east-most north-row pad |
| 15 | IO3 | OC1_OUT | house bell sense (Türruf) |
| 17 | IO1 | OC2_OUT | apartment bell sense (Etagenruf) |

All four active GPIOs are on the north castellated row (pads 10–18), facing both the relay cluster
and the opto block. IO20/U0RXD is safe as a gate driver: high-Z input at reset, 10 kΩ pull-down
holds K2 off. IO21/U0TXD (pad 12) is N/C — ROM drives it HIGH at boot. Non-strapping: IO1/IO3/IO10/IO20
(strapping = IO2/IO8/IO9). Firmware: `../doorbell-v4.yaml`, `board: esp32-c3-devkitm-1`.

## Net list (draw these connections)

Opto pins (PC817/LTV-217): **1 = anode, 2 = cathode, 3 = emitter, 4 = collector**.

```
# ---- Power (VBUS -> SS14 D4 reverse-protect -> +5V -> SGM2212 U2 -> +3V3) ----
VBUS   : J1.VBUS(A4,B4,A9,B9)  D4.A  D5.VP(5)                  # raw USB, pre-Schottky
+5V    : D4.K  C_in.1  U2.VI  K1.coil  K2.coil  D1.K  D2.K  PWR_FLAG   # post-Schottky
+3V3   : U2.VO  C_out.1  C_3v3.1  C_dec.1  U1.3V3  R_en.1  R_boot.1  R_io8.2  R_led.1  PWR_FLAG
GND    : J1.GND(A1,B1,A12,B12)  J1.SHIELD  C_in.2  C_out.2  C_3v3.2  C_dec.2  U2.GND
         U1.GND  U1.EP  Q1.S  Q2.S  R_pd1.2  R_pd2.2  R_em.2  C_en.2  D5.VN(2)
         R_cc1.2  R_cc2.2  LED_pwr.K  SW_boot.2  SW_en.2  PWR_FLAG

# ---- USB-C ----
USB_DM : J1.D-(A7,B7)  U1.IO18  D5.IO(3)
USB_DP : J1.D+(A6,B6)  U1.IO19  D5.IO(1)
CC1    : J1.CC1  R_cc1.1
CC2    : J1.CC2  R_cc2.1

# ---- Reset / boot / straps ----
EN_NET   : U1.EN   R_en.2   C_en.1   SW_en.1
BOOT_NET : U1.IO9  R_boot.2 SW_boot.1
GPIO8    : U1.IO8  R_io8.1            # strap: 10k pull-up to +3V3 (download-mode robustness)

# ---- Relay K1 driver (door opener / ÖT) ----
GATE1_DRV : U1.IO20  R_g1.1
GATE1     : R_g1.2  Q1.G  R_pd1.1
K1_DRAIN  : Q1.D  K1.coil  D1.A

# ---- Relay K2 driver (chime suppress) ----
GATE2_DRV : U1.IO10  R_g2.1
GATE2     : R_g2.2  Q2.G  R_pd2.1
K2_DRAIN  : Q2.D  K2.coil  D2.A

# ---- Bus / WF26 (J2: pin n = line n) + relay contacts (CARRIED FROM V3) ----
P1     : J2.1  R_lim1.2  R_lim2.2  # bus common — NOT board GND (keep isolated!)
P2     : J2.2  K1.COM             # K1 COM
P3     : J2.3  K1.NO              # K1 NO  -> energise K1 bridges P2+P3 (ÖT)
P4     : J2.4  K2.COM             # K2 COM
IN_P4  : K2.NC  OC1.1(anode)      # post-K2 node (chime + house-bell sense)
P5     : J2.5  OC2.1(anode)
#   K1.NC and K2.NO are intentionally unconnected.

# ---- Bell sense front-end (CARRIED FROM V3, do not re-tune) ----
OC1_CATH : OC1.2  R_lim1.1         # OC1 cathode -> its own R_lim1(5.1k) -> P1
OC2_CATH : OC2.2  R_lim2.1         # OC2 cathode -> its own R_lim2(5.1k) -> P1 (unshared)
OC1_OUT : OC1.4(collector)  U1.IO3   # ESP internal pull-up in firmware
OC2_OUT : OC2.4(collector)  U1.IO1
OC_EMIT : OC1.3  OC2.3  R_em.1    # shared emitters -> R_em(1k) -> GND

# ---- Power LED ----
LED_A  : R_led.2  LED_pwr.A
```

The net list above is the design intent; `gen_schematic.py` already wires all of it (the
generator uses internal keys `R_lim1`/`C_in`/… mapped to designators R1/R2/C2/…; see the
`REF` table in the script). The contacts were verified against the written file:
`P2 = J2.2 + K1.3(COM)`, `P3 = J2.3 + K1.4(NO)`, `P4 = J2.4 + K2.3(COM)`,
`IN_P4 = K2.2(NC) + OK1.1(anode)`.

## Next steps (in Eeschema)

1. Open `doorbell.kicad_pro` in KiCad 10 (Espressif + CDFER libraries installed; they are).
2. The schematic is electrically complete via labels. Optionally **drag parts into a tidy
   layout and draw wires** — purely cosmetic; ERC connectivity already holds.
3. Footprints come from the symbols. Confirm: U1 (Espressif), relay = `Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y`,
   J2 = `TerminalBlock_4Ucon` 6-way screw terminal (THT, JLCPCB-assembled — not hand-soldered).
4. Re-run ERC — invariants that must stay true:
   - K1: P2→COM(3), P3→NO(4), **NC(2) No-Connect**. K2: P4→COM(3), IN_P4→NC(2), **NO(4) No-Connect**.
   - Relay gates have 10 kΩ pull-downs to GND (relays default **off** at boot).
   - `P1` connects only to J2.1 and the two limiters R1/R2 — **never to GND** (bus/logic isolation).
   - Each opto LED returns to `P1` via its own limiter (R1/R2), not GND; R3 is the shared emitter resistor.
5. Update PCB from schematic; in layout keep an isolation gap between bus nets (P1–P5, IN_P4)
   and logic (GND/+3V3/+5V), and an antenna keep-out under U1.
6. Export BOM + CPL for JLCPCB (CDFER fields populate LCSC/rotation). Verify LCSC stock for
   U1, J1 and the relay; the relay needs its LCSC field set (Omron G6K-2F-Y-TR DC4.5 = C397193).
