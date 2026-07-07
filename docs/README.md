# Datasheets & reference docs

Local copies of the primary sources behind the design, so the references don't rot. The
**authoritative part list is the schematic** (`kicad/doorbell.kicad_sch`, hidden `LCSC`/`MPN`
fields) exported to `fab/doorbell-bom-jlcpcb.csv` — this folder is not a BOM, just the
backing documents. For *how* to use them to check the board, see `../VERIFICATION.md`.

## Layout

- **`datasheets/`** — component datasheets for the parts on the board.
- **`design/`** — intercom/handset reference docs, ESP32 design guides, the Fritzing source.
- **`ordering/`** — JLCPCB capability PDFs and the prefab verification report.

## Intercom & handset (in `design/`)

| File | What |
|------|------|
| `STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf` | STR TV20/S service plan — Verdrahtungsplan + Fehlersuchhilfe. The authority for the bus (terminal 4 = Türruf ≈ 12 VDC, ÖT bridges 2 & 3, ET interrupts line 5). |
| `HJR4102.PDF` | HJR-4102 — the WF26's own latch relay (the part the on-board G6K replica reproduces). |
| `KlingelV4.fzz` | Fritzing source for the V3 perfboard build / early V4 reference. |

## Current-design part datasheets (in `datasheets/`)

For the parts on the board: the **ESP32-S3-WROOM-1U-N16R8** module (`esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf`,
pad map + strapping), **ES8311** codec (`ES8311_datasheet.pdf` + `ES8311.user.Guide.pdf`),
**SGM2212** LDO (`sgm2212_datasheet.pdf`), **TPD2S017** USB ESD (`tpd2s017_datasheet.pdf`),
**Omron G6K** relay (`g6k_datasheet.pdf`), **SUPSiC GAQY412E/EH** PhotoMOS
(`GAQY412E_EH_datasheet.pdf`), and the **SPPJ322300** door switch (`SPPJ322300_datasheet.pdf`).
Parts reasoned from standard pin conventions (SS14, SMF5.0A, 1N4148W, the USB-C jack, the
GAQW/GAQY212GS SSRs) have no local sheet — see `../VERIFICATION.md` §7.

## Fab capability (in `ordering/`)

`PCB Manufacturing & Assembly Capabilities - JLCPCB.pdf` and `… - JLCPCB - PCBA.pdf` — JLCPCB's
published PCB/PCBA capability limits (clearances, assembly rules), the basis for the DRU and the
ordering notes in `../ORDERING.md`.

