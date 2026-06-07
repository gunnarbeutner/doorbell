# Doorbell V4 — code-generated KiCad project

## Build pipeline (everything regenerates from `doorbell_design.py`)

`doorbell_design.py` is the single source of truth (components, nets, footprints,
placement). Two generators consume it; `build.sh` orchestrates them:

```
./build.sh            # schematic + PCB (unrouted) + ERC + schematic PDF
./build.sh route      # autoroute the PCB with Freerouting
./build.sh fab        # Gerbers + drill + position + BOM -> kicad/fab/
./build.sh all-route  # schematic + PCB + route + fab (full run)
```

| Script | Interpreter | Output |
|--------|-------------|--------|
| `gen_schematic.py` | `.venv/bin/python` (kiutils) | `doorbell.kicad_sch` — ERC 0 errors |
| `gen_pcb.py` | KiCad bundled python (pcbnew) | `doorbell.kicad_pcb` — placed + netted, 0 DRC |
| `route.py` | KiCad bundled python (pcbnew) | routes the board via Freerouting |

**Freerouting** is wired in via `route.py`: `pcbnew.ExportSpecctraDSN` → Freerouting
headless (`/Applications/freerouting.app`, `-de in.dsn -do out.ses -mp N`) →
`pcbnew.ImportSpecctraSES` → save. A full route of this board takes ~6 s and reaches
0 DRC violations / 0 unconnected pads. Re-running `gen_pcb.py` wipes routes (fresh
ratsnest), so iterate as: edit `doorbell_design.py` → `./build.sh` → `./build.sh route`.

> The generated PCB inherits the schematic's spread-out cluster placement (≈167×117 mm),
> so it routes but with long traces — drag parts into a compact arrangement in the PCB
> editor (or tighten `SCALE`/`GRID`) before a real fab run.

---

# Reference: scaffold + capture spec

Single-board redesign of the Klingel controller (ESP32-C3 + USB-C + on-board relay
drivers). See `../DESIGN.md` for the full rationale; this folder is the KiCad starting
point. **Carry the proven V3 analog path over verbatim** — do not re-tune the opto
front-end (PC817/LTV-217, R_lim = 5.1 kΩ, R_em = 1 kΩ) or the relay contact arrangement.

## What's in here

| File | Status |
|------|--------|
| `doorbell.kicad_sch` | **Generated schematic** — 35 parts, all V4 nets. Loads in KiCad 10, **ERC: 0 errors**, 8 benign warnings (see below). |
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
The 8 ERC **warnings** are all `pin_to_pin: Unspecified and Passive` — they come from CDFER
symbols (the LDO and tactile buttons) whose pins are typed *Unspecified*; harmless.

## Part mapping (symbol → footprint → LCSC)

| Ref | Value | Symbol | Footprint | LCSC |
|-----|-------|--------|-----------|------|
| U1 | ESP32-C3-MINI-1 | `PCM_Espressif:ESP32-C3-MINI-1` | (from symbol) ¹ | C2891487 ² |
| U2 | AMS1117-3.3 | `PCM_JLCPCB-Power:LDO, 3.3V, 1A` | (from symbol) | (from symbol) |
| J1 | USB-C 2.0 | `Connector:USB_C_Receptacle_USB2.0_16P` | `Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12` | C165948 ² |
| J2 | WF26 5-pin | `Connector_Generic:Conn_01x05` | Wago 2604-1105 ³ | — (hand-place) |
| K1, K2 | Relay 5 V SPDT | `Relay:G6K-2` ⁴ | `Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y` | C2904432 ² |
| Q1, Q2 | 2N7002 | `PCM_JLCPCB-Transistors:NMOS,2N7002` | (from symbol) | C8545 |
| D1, D2 | 1N4148W | `PCM_JLCPCB-Diodes:Switching,1N4148W` | (from symbol) | (from symbol) |
| OC1, OC2 | PC817 (SMD) | `PCM_JLCPCB-Optocouplers:LTV-217-B-G` ⁵ | (from symbol) | (from symbol) |
| R_lim | 5.1 kΩ | `PCM_JLCPCB-Resistors:0603,5.1kΩ` | (from symbol) | (from symbol) |
| R_em | 1 kΩ | `PCM_JLCPCB-Resistors:0603,1kΩ` | (from symbol) | (from symbol) |
| R_g1, R_g2 | 100 Ω | `PCM_JLCPCB-Resistors:0603,100Ω` | (from symbol) | (from symbol) |
| R_pd1, R_pd2, R_en, R_boot | 10 kΩ | `PCM_JLCPCB-Resistors:0603,10kΩ` | (from symbol) | (from symbol) |
| R_cc1, R_cc2 | 5.1 kΩ | `PCM_JLCPCB-Resistors:0603,5.1kΩ` | (from symbol) | (from symbol) |
| R_led | 1 kΩ | `PCM_JLCPCB-Resistors:0603,1kΩ` | (from symbol) | (from symbol) |
| C_bulk | 100 µF | `PCM_JLCPCB-Capacitors:CASE-B-3528-21(mm),100uF` | (from symbol) | (from symbol) |
| C_in, C_3v3 | 10 µF | `PCM_JLCPCB-Capacitors:0603,10uF` | (from symbol) | (from symbol) |
| C_out | 22 µF | `PCM_JLCPCB-Capacitors:0603,22uF` | (from symbol) | (from symbol) |
| C_en, C_dec | 100 nF | `PCM_JLCPCB-Capacitors:0603,100nF` | (from symbol) | (from symbol) |
| LED_pwr | Green | `PCM_JLCPCB-Diodes:LED,0603,Green` | (from symbol) | (from symbol) |
| SW_boot, SW_en | button (opt.) | `PCM_JLCPCB-Connectors_Buttons:Tactile Button, 160gf, 12V, 50mA, 4.0mm` | (from symbol) | (from symbol) |

¹ Uses your installed Espressif library symbol+footprint (correct official pads).
² Verify LCSC stock at order time. ³ Spring-cage Wago: not a
JLCPCB-assembly part — hand-solder after SMT. ⁴ `G6K-2` is DPDT; use **one Form C pole**.
⁵ LTV-217 is the JLCPCB-stocked 817-family SMD opto (PC817 equivalent); swap for `PC817S`
if you prefer the exact V3 part.

## ESP32-C3-MINI-1 pin usage (official pads)

| Pad | Pin | Net | Role |
|-----|-----|-----|------|
| 3 | 3V3 | +3V3 | supply |
| 1 + 49(EP) | GND | GND | supply + thermal |
| 8 | EN | EN_NET | reset (R_en↑ + C_en) |
| 23 | IO9 | BOOT_NET | strap (R_boot↑, SW_boot) |
| 26 | IO18 | USB_DM | USB D− |
| 27 | IO19 | USB_DP | USB D+ |
| 18 | IO4 | GATE1_DRV | K1 driver (door / ÖT) |
| 19 | IO5 | GATE2_DRV | K2 driver (chime) |
| 20 | IO6 | OC1_OUT | house bell sense (Türruf) |
| 21 | IO7 | OC2_OUT | apartment bell sense (Etagenruf) |

IO4–IO7 are all non-strapping (strapping = IO2/IO8/IO9). Update `../doorbell.yaml`
to these GPIOs when moving off the ESP32dev board.

## Net list (draw these connections)

Opto pins (PC817/LTV-217): **1 = anode, 2 = cathode, 3 = emitter, 4 = collector**.

```
# ---- Power ----
+5V    : J1.VBUS  C_bulk.+  C_in.1  U2.VI  K1.coil  K2.coil  D1.K  D2.K  PWR_FLAG
+3V3   : U2.VO  C_out.1  C_3v3.1  U1.3V3  R_en.1  R_boot.1  R_led.1
GND    : J1.GND  J1.SHIELD  C_bulk.-  C_in.2  C_out.2  C_3v3.2  U2.GND
         U1.GND  U1.EP  Q1.S  Q2.S  R_pd1.2  R_pd2.2  R_em.2  C_en.2  LED_pwr.K
         R_cc1.2  R_cc2.2  PWR_FLAG

# ---- USB-C ----
USB_DM : J1.D-(A7,B7)  U1.IO18
USB_DP : J1.D+(A6,B6)  U1.IO19
CC1    : J1.CC1  R_cc1.1
CC2    : J1.CC2  R_cc2.1

# ---- Reset / boot ----
EN_NET   : U1.EN   R_en.2   C_en.1   SW_en.1(opt)
BOOT_NET : U1.IO9  R_boot.2 SW_boot.1(opt)

# ---- Relay K1 driver (door opener / ÖT) ----
GATE1_DRV : U1.IO4  R_g1.1
GATE1     : R_g1.2  Q1.G  R_pd1.1
K1_DRAIN  : Q1.D  K1.coil  D1.A

# ---- Relay K2 driver (chime suppress) ----
GATE2_DRV : U1.IO5  R_g2.1
GATE2     : R_g2.2  Q2.G  R_pd2.1
K2_DRAIN  : Q2.D  K2.coil  D2.A

# ---- Bus / WF26 (J2: pin n = line n) + relay contacts (CARRIED FROM V3) ----
P1     : J2.1  R_lim.2            # bus common — NOT board GND (keep isolated!)
P2     : J2.2  K1.COM             # K1 COM
P3     : J2.3  K1.NO              # K1 NO  -> energise K1 bridges P2+P3 (ÖT)
P4     : J2.4  K2.COM             # K2 COM
IN_P4  : K2.NC  OC1.1(anode)      # post-K2 node (chime + house-bell sense)
P5     : J2.5  OC2.1(anode)
#   K1.NC and K2.NO are intentionally unconnected.

# ---- Bell sense front-end (CARRIED FROM V3, do not re-tune) ----
OC_CATH : OC1.2  OC2.2  R_lim.1   # shared cathodes -> R_lim(5.1k) -> P1
OC1_OUT : OC1.4(collector)  U1.IO6   # ESP internal pull-up in firmware
OC2_OUT : OC2.4(collector)  U1.IO7
OC_EMIT : OC1.3  OC2.3  R_em.1    # shared emitters -> R_em(1k) -> GND

# ---- Power LED ----
LED_A  : R_led.2  LED_pwr.A
```

The net list above is the design intent; `gen_schematic.py` already wires all of it (the
generator uses internal keys `R_lim`/`C_bulk`/… mapped to designators R1/R2/C1/…; see the
`REF` table in the script). The contacts were verified against the written file:
`P2 = J2.2 + K1.3(COM)`, `P3 = J2.3 + K1.4(NO)`, `P4 = J2.4 + K2.3(COM)`,
`IN_P4 = K2.2(NC) + OK1.1(anode)`.

## Next steps (in Eeschema)

1. Open `doorbell.kicad_pro` in KiCad 10 (Espressif + CDFER libraries installed; they are).
2. The schematic is electrically complete via labels. Optionally **drag parts into a tidy
   layout and draw wires** — purely cosmetic; ERC connectivity already holds.
3. Footprints come from the symbols. Confirm: U1 (Espressif), relay = `Relay_SMD:Relay_DPDT_Omron_G6K-2F-Y`,
   J2 = your Wago 2604-1105 footprint (hand-place).
4. Re-run ERC — invariants that must stay true:
   - K1: P2→COM(3), P3→NO(4), **NC(2) No-Connect**. K2: P4→COM(3), IN_P4→NC(2), **NO(4) No-Connect**.
   - Relay gates have 10 kΩ pull-downs to GND (relays default **off** at boot).
   - `P1` connects only to J2.1 and R1 — **never to GND** (bus/logic isolation).
   - Opto LEDs return to `P1` (R1), not GND; R2 is on the emitters.
5. Update PCB from schematic; in layout keep an isolation gap between bus nets (P1–P5, IN_P4)
   and logic (GND/+3V3/+5V), and an antenna keep-out under U1.
6. Export BOM + CPL for JLCPCB (CDFER fields populate LCSC/rotation). Verify LCSC stock for
   U1, J1 and the relay; the relay needs its LCSC field set (Omron G6K-2F-Y-TR DC4.5 = C397193).
