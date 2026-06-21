# ESP32-S3 module-board best practices — reference checklist

A generic design checklist for a custom **ESP32-S3-MINI** module board, compiled from Espressif's
hardware-design guidelines and the usual beginner guides. This is **reference only** — how V4
actually implements each item is in `../DESIGN.md` (power tree, GPIO map, SSR LED drive, USB
front-end, PCB layout) and is confirmed by the gates in `../VERIFICATION.md`. Don't restate the
board's pin map or part values here; read them from the schematic.

The third-party guides mostly restate Espressif's guidelines (and sometimes mix in *ESP32-classic*
advice — GPIO0/GPIO12 strapping, CAP1/CAP2 LDO caps — that does **not** apply to the S3).

## We use a *module*, not a bare chip

V4 uses the **ESP32-S3-MINI-1U module** (u.FL external antenna; N8 = 8 MB flash, no PSRAM). The
module already integrates the 40 MHz crystal, RF matching, the SPI flash, and the chip's closest-in
decoupling — so a large slice of "first ESP32 board" advice is about things **sealed inside the
module** and is simply N/A:

| Bare-chip rule | Why N/A for a module design |
|---|---|
| 50 Ω RF trace, crystal placement, RF matching with 0201s | RF + crystal are inside the module |
| VDD_SPI 1 µF, flash-pin routing, series 0 Ω on SPI | Flash + SPI are inside the module |
| CAP1/CAP2 internal-LDO caps | ESP32-classic only; not an S3 pin |
| Thermal vias under the chip's GND EPAD | Applies to the module's own land pattern |
| PCB-antenna 15 mm keep-out, RF-transparent edge | The **-1U** variant has a u.FL **external** antenna — no on-board antenna to keep clear |

What **does** still apply: power/decoupling at the module's 3V3 pin, the EN reset RC, strapping-pin
states, GPIO/boot hygiene, the USB front-end, and general layout/ground-plane practice.

## The checklist

### 1. Power supply & decoupling
- Budget for the **WiFi-TX burst** (~350–500 mA peaks → brownout resets if the supply or caps are
  weak). Espressif: 3.0–3.6 V, ≥500 mA.
- Bulk + light decoupling at the module 3V3 pin (guides: ~10 µF + 0.1 µF close to the pin, short
  ground via), plus input bulk and a reverse-protection diode at the power entrance.
- **Pick a low-dropout LDO with good transient response.** Guides warn explicitly **against
  AMS1117** (1.1–1.3 V dropout → browns out from 5 V-minus-losses under TX load). Prefer a fast
  low-dropout part.

### 2. EN / reset
- Never leave EN/CHIP_EN floating: 10 kΩ pull-up to 3V3 + **1 µF** to GND (Espressif's EN-RC value
  — reset releases after the rail is stable). A reset button to GND is handy.

### 3. Strapping / boot pins (S3-specific)
- S3 strapping pins are **GPIO0, GPIO3, GPIO45, GPIO46** (*not* the C3's GPIO2/8/9, nor the
  classic ESP32's GPIO0/GPIO12).
- **GPIO0 = BOOT:** 10 kΩ pull-up (default SPI boot), button to GND for download mode. Don't hang a
  large cap on it.
- **GPIO3** (JTAG source select), **GPIO45** (VDD_SPI voltage), **GPIO46** (boot/ROM-msg) — leave
  at their default state or drive them to a known-valid level at reset; don't put I/O on them
  unless you respect the boot state.

### 4. GPIO / flash pin hygiene
- The module hides the SPI-flash pins; don't route to them. On the **N8** (flash-only) part the
  pins used for octal PSRAM on `-N*R*` variants are free, but check the exact module variant.
- Give every output a **defined power-on state** (e.g. a gate pull-down) so a glitch can't fire a
  load at boot.

### 5. USB (native USB-Serial-JTAG on the S3)
- USB is on **GPIO19 (D−) / GPIO20 (D+)** — keep them a tight differential pair over a ground
  reference, short.
- Add **ESD protection** on the USB lines (and optional series-R footprints near the connector).
- **CC pins:** 5.1 kΩ pull-downs to GND (one per CC) to advertise as a UFP/sink.

### 6. Antenna / RF
- The **-1U** module's antenna is **external via u.FL** — route the lead out of any metal
  enclosure; there is no on-board antenna keep-out to honour. (If you ever use a **-1** PCB-antenna
  module instead: hang it off the board edge, or keep a ≥15 mm copper/part keep-out around it.)
- Keep USB and switching parts away from the antenna feed/lead.

### 7. PCB layout / stackup
- **Solid ground plane.** On 4-layer keep one layer a complete GND plane with no signal traces;
  don't carve it up with routing (bad return paths → EMI, brownouts).
- Decoupling caps close to pins; short return vias.

### 8. Manufacturing / assembly (JLCPCB etc.)
- Use in-stock parts (prefer Basic/Preferred); second-source critical parts.
- Add fiducials, mounting holes, test points; verify **polarized-part rotations** against the
  assembler's convention before ordering (see `../ORDERING.md`).
- Add a power LED and BOOT/EN buttons or pads for bring-up.

## How V4 applies this

See `../DESIGN.md`: the **Power tree** (SGM2212 low-dropout LDO chosen over the AMS1117 for exactly
the brownout reason above; SS14 input protection; no bulk electrolytic), the **GPIO map** (the BOOT
strap on IO0, EN-RC on EN, native USB on IO19/IO20, actuators on non-strapping pins), the **SSR LED
drive** (gate pull-downs ⇒ actuators default off at boot, SAFE-6), the **USB front-end** (TPD2S017
ESD, CC 5.1 kΩ Rd), and **PCB layout** (solid In1 +3V3 / In2 GND planes, u.FL external antenna).
The gates in `../VERIFICATION.md` confirm them.

## Sources
- [Espressif — ESP32-S3 Schematic Checklist](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/schematic-checklist.html)
- [Espressif — ESP32-S3 PCB Layout Design](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/pcb-layout-design.html)
- [Espressif — Boot Mode Selection (ESP32-S3, esptool)](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html)
- [espboards.dev — ESP32 Strapping Pins (ESP32/S3/C3/C6)](https://www.espboards.dev/blog/esp32-strapping-pins/)
