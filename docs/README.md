# Datasheets & review references

Primary-source documents backing the pre-fab review findings. Local copies so the references
don't rot.

| File | Part / doc | Source |
|------|-----------|--------|
| `esp32-c3-mini-1_datasheet_en.pdf` | ESP32-C3-MINI-1 module (U1) | espressif.com/.../esp32-c3-mini-1_datasheet_en.pdf |
| `esp32-c3_datasheet_en.pdf` | ESP32-C3 chip (GPIO, strapping) | espressif.com/.../esp32-c3_datasheet_en.pdf |
| `esp32-c3_hardware_design_guidelines_en.pdf` | ESP32-C3 HW Design Guidelines | docs.espressif.com/projects/esp-hardware-design-guidelines/.../esp32c3/ |
| `ams1117_datasheet.pdf` | AMS1117-3.3 LDO (U2) | advanced-monolithic.com/pdf/ds1117.pdf |
| `kyocera-avx_TAJ_tantalum_datasheet.pdf` | Kyocera-AVX TAJ tantalum series (C1 part) | datasheets.kyocera-avx.com/TAJ.pdf |

## Decoupling / bulk capacitors — required values

The ESP32-C3-MINI-1 is a **module** (internal chip decoupling included), so externally it only
needs the 3V3 supply + light decoupling.

| Cap | Net / role | Design value | Required value | Reference | OK? |
|-----|-----------|--------------|----------------|-----------|-----|
| C3 `C_3v3` | 3V3 bulk at module | 10 µF | 10 µF | HW Design Guidelines, Power Scheme (VDD3P3 = 10 µF) | ✅ |
| C6 `C_dec` | 3V3 decoupling | 0.1 µF | 0.1 µF | HW Design Guidelines (0.1 µF close to pin) | ✅ |
| C4 `C_out` | LDO output (3V3) | 22 µF | ≥ 22 µF | AMS1117 datasheet — characterised with C_OUT = 22 µF tantalum | ✅ |
| C2 `C_in` | LDO input | 10 µF | ~10 µF | AMS1117 typical application | ✅ |
| C1 `C_bulk` | 5 V (VBUS) bulk | 100 µF / **6.3 V tantalum** | ~100 µF / **≥16 V**, non-tantalum | see finding C1 below | ❌ voltage |

**Answer to "what capacitance should they have / does the ESP32 datasheet say anything":**
the *capacitances* are already correct. The ESP32-C3-MINI-1 datasheet (Table 6-2) only specifies
the **supply: 3.0–3.6 V, I_VDD ≥ 0.5 A** and does not prescribe decoupling values; those come
from the HW Design Guidelines (10 µF + 0.1 µF on 3V3) and the AMS1117 datasheet (22 µF output).
C1's *capacitance* is fine — only its **voltage rating** (and part type) must change.

## Findings → references

**[CRITICAL] C1 bulk cap under-rated (6.3 V tantalum on 5 V rail)**
- Placed: `kicad/doorbell_design.py:43` (`C_bulk` = CASE-B-3528, 100 µF); on `+5V` net `:82`.
- BOM `C16133` = **Kyocera-AVX TAJB107K006RNJ, 100 µF 6.3 V tantalum** (lcsc.com/product-detail/C16133.html; series ds `kyocera-avx_TAJ_tantalum_datasheet.pdf`).
- VBUS = 4.75–5.25 V (USB 2.0 §7.2 / USB-C up to 5.5 V) → ~80–83 % of 6.3 V.
- `kyocera-avx_TAJ_tantalum_datasheet.pdf`: 6.3 V part Category Voltage ≤125 °C ≈ 4 V (Ratings table); AVX recommends ~50 % voltage derating on low-impedance rails. Both violated.
- Doc mismatch: `DESIGN.md` says 470 µF.
- **Fix:** ~100 µF (or 470 µF) at **≥16 V**, aluminium-polymer or 25 V MLCC (not tantalum on a hot-plug rail). Needs a footprint change (CASE-B can't hold 100 µF/16 V).

**[CRITICAL] doorbell.yaml is the V3 firmware**
- `doorbell.yaml:5` `board: esp32dev`; relay outputs `pin: 25` `:135`, `pin: 26` `:139` (+ bell inputs on 32/33). ESP32-C3 has only **GPIO0–GPIO21** — `esp32-c3_datasheet_en.pdf` Pin Definitions (no GPIO25/26/32/33).
- Correct V4 map: IO4=K1, IO5=K2, IO6=OC1, IO7=OC2 — `DESIGN.md` GPIO table + `kicad/doorbell_design.py` NETS.
- Relay polarity: `inverted: true` on outputs `doorbell.yaml:137,141` must be **removed** — V4 driver is NMOS + gate pull-down = active-high (`DESIGN.md` relay-driver section).

**[SHOULD-FIX] U1/K1/K2 CPL rotations unverified**
- `kicad/doorbell_design.py:59` U1 = `PCM_Espressif`, `:63–64` K1/K2 = `Relay_SMD` (KiCad stock) — not the CDFER `PCM_JLCPCB` library the passives use, so not pre-aligned to JLCPCB 0°. Verify in JLCPCB preview; add `ROT_FIX` in `kicad/jlcpcb_cpl.py`.

**[SHOULD-FIX] GPIO8 / GPIO2 floating strapping pins**
- `kicad/doorbell_design.py:120–127` `NOCONN` includes `("U1","22")`=GPIO8 and `("U1","5")`=GPIO2.
- Strapping pins = GPIO2/8/9: `esp32-c3_datasheet_en.pdf` §3 Boot Configurations (Table 3-1) and pin table (GPIO8 = IE only, GPIO9 = IE+WPU); `esp32-c3_hardware_design_guidelines_en.pdf` §1.3.9: "GPIO2, GPIO8, GPIO9 are strapping pins," default config GPIO2/GPIO8 = floating, GPIO9 = pull-up, and "add a pull-up or pull-down resistor to pins in the high-impedance state."
- **Fix:** 10 kΩ pull-up on GPIO8 (and GPIO2). GPIO9 already has 10 k + button.

**[Confirmed OK]**
- Netlist vs Fritzing `KlingelV4.fzz`: front-end matches `doorbell_design.py` NETS; only documented V4 changes differ.
- USB flashing: D+ = J1 A6+B6→IO19, D− = A7+B7→IO18; CC1/CC2 own 5.1 k; VBUS→LDO (`doorbell_design.py` NETS `:82`,`:86`).
- BOM parts verified at lcsc.com (relay C2982926, MCU C2838502, opto C115450, USB C7095263, terminal C5290323).
