# Datasheets & reference docs

Local copies of the primary sources behind the design, so the references don't rot. The
**authoritative part list is the schematic** (`kicad/doorbell.kicad_sch`, hidden `LCSC`/`MPN`
fields) exported to `kicad/fab/doorbell-bom-jlcpcb.csv` — this folder is not a BOM, just the
backing documents. For *how* to use them to check the board, see `../VERIFICATION.md`.

## Intercom & handset (the primary reverse-engineering sources)

| File | What |
|------|------|
| `STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` | STR TV20/S service plan — Verdrahtungsplan + Fehlersuchhilfe. The authority for the bus (terminal 4 = Türruf ≈ 12 VDC, ÖT bridges 2 & 3, ET interrupts line 5). |
| `HJR4102.PDF` | HJR-4102 — the WF26's own latch relay (the part the on-board G6K replica reproduces). |
| `KlingelV4.fzz` | Fritzing source for the V3 perfboard build / early V4 reference. |

## Current-design part datasheets

For the parts on the board: the **ESP32-S3-MINI-1/1U** module (`esp32-s3-mini-1_mini-1u_datasheet_en.pdf`,
pad map + strapping), **ES8311** codec (`ES8311_datasheet.pdf` + `ES8311.user.Guide.pdf`),
**SGM2212** LDO (`sgm2212_datasheet.pdf`), **TPD2S017** USB ESD (`tpd2s017_datasheet.pdf`),
**Omron G6K** relay (`g6k_datasheet.pdf`), **Panasonic GAQY412E/EH** PhotoMOS
(`GAQY412E_EH_datasheet.pdf`), and the **SPPJ322300** door switch (`SPPJ322300_datasheet.pdf`).
Parts reasoned from standard pin conventions (SS14, SMF5.0A, 1N4148W, the USB-C jack, the
GAQW/GAQY212GS SSRs) have no local sheet — see `../VERIFICATION.md` §7.

## Fab capability

`PCB Manufacturing & Assembly Capabilities - JLCPCB.pdf` and `… - JLCPCB - PCBA.pdf` — JLCPCB's
published PCB/PCBA capability limits (clearances, assembly rules), the basis for the DRU and the
ordering notes in `../ORDERING.md`.

## Superseded / reference-only

Kept for history; **not** the current design — do not size parts from these:

- Earlier MCU iterations: `esp32-c3-*`, `esp32-c6-*` module/devkit sheets (the design moved
  C3 → C6 → **S3**).
- Rejected or dropped parts: `ams1117_datasheet.pdf` (the high-dropout LDO rejected for the
  SGM2212), `kyocera-avx_TAJ_tantalum_datasheet.pdf` (old bulk-cap study), `SM-LP-5001_datasheet.pdf`
  (the isolation transformer dropped for the transformer-less audio front-end), `cp2102n-datasheet.pdf`
  (USB-UART, superseded by native USB), `SPPJ223200_datasheet.pdf` (alternate switch variant).
