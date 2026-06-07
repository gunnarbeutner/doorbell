# ESP32 custom-PCB best practices — checklist & how the V4 doorbell measures up

Compiled from beginner guides and Espressif's own hardware-design guidelines
(2026-06-07). The authoritative sources are Espressif's **ESP32-C3 Schematic
Checklist** and **PCB Layout Design** pages; the third-party guides mostly
restate these (and sometimes mix in *ESP32-classic* advice — e.g. GPIO0/GPIO12
strapping, CAP1/CAP2 LDO caps — that does **not** apply to the C3).

## Important framing: we use a *module*, not a bare chip

V4 uses the **ESP32-C3-MINI-1 module**. The module already integrates the 40 MHz
crystal, the RF matching network, the PCB antenna, the SPI flash, and the chip's
closest-in decoupling. So a large slice of "first ESP32 board" advice is about
things **sealed inside the module** and is simply **N/A** for us:

| Bare-chip rule | Why N/A for a module design |
|---|---|
| 50 Ω RF trace, no vias, 135° bends | RF is internal; module exposes only the antenna |
| CLC/π antenna matching with 0201s | Matching is inside the module |
| 40 MHz crystal placement / ≥2.7 mm gap, ±10 ppm | Crystal is inside the module |
| VDD_SPI 1 µF, flash-pin routing, series 0 Ω on SPI | Flash + SPI are inside the module |
| CAP1/CAP2 10 nF internal-LDO caps | ESP32-classic only; not a C3 pin anyway |
| 9 thermal vias under the chip's GND EPAD | Applies to the module's own land pattern |

What **does** still apply to a module board: power/decoupling at the module's
3V3 pin, the EN reset RC, strapping-pin states, GPIO/boot hygiene, the USB
front-end, antenna keep-out/placement, and general layout/ground-plane practice.

---

## The best-practices checklist

### 1. Power supply & decoupling
- **Budget for ≥500 mA at 3.3 V.** WiFi TX bursts (~350–500 mA) cause rail
  collapse → brownout resets if the supply or caps are weak. *(Espressif: "output
  current no less than 500 mA"; 3.0–3.6 V.)*
- **Bulk cap at the power entrance:** ≥10 µF (guides say 10–22 µF), plus an
  **ESD/reverse-protection diode** at the input.
- **10 µF on the 3V3 rail** for the TX surge, and **0.1 µF close to the module's
  3V3 pin** for HF decoupling. Place decoupling caps right at the pin with a short
  ground via.
- **Pick an LDO with low dropout and good transient response.** Beginner guides
  explicitly warn **against AMS1117** (1.1–1.3 V dropout → browns out from a
  5 V-minus-losses input under TX load). Prefer a fast ~600 mA part.
- **Wide power traces** (bare-chip rule, but good hygiene): main ≥25 mil, 3V3
  ≥20 mil; on a plane this is automatic.

### 2. EN / reset
- **Never leave EN/CHIP_EN floating.** Pull-up **10 kΩ** to 3V3 + **1 µF** to GND
  (RC delay so reset releases after the rail is stable; ≥50 µs). A reset button to
  GND is optional but handy.

### 3. Strapping / boot pins (C3-specific!)
- C3 strapping pins are **GPIO2, GPIO8, GPIO9** (*not* GPIO0/GPIO12 — that's the
  classic ESP32).
- **GPIO9 = BOOT:** 10 kΩ **pull-up** (default SPI boot), button to GND for
  download mode. **Do not hang a big cap on GPIO9** or it boots into download mode.
- **GPIO8:** needs a **pull-up** for reliable download mode (10 kΩ).
- **GPIO2:** must be **high (or floating)** at boot; Espressif recommends a 10 kΩ
  pull-up to harden boot against glitches (optional).
- **Don't put your own I/O on strapping pins** unless you respect their boot state.

### 4. GPIO / flash pin hygiene
- On the C3, **GPIO11–GPIO17 are tied to internal flash** — never use them.
  (Module hides them, but don't try.)
- Keep relay/output loads off strapping pins so a glitch can't fire them at boot;
  give every output a **defined power-on state** (pull-down on a driver gate, etc.).

### 5. USB (native USB-Serial-JTAG on the C3)
- USB is on **GPIO18 (D−) / GPIO19 (D+)** — keep them as a **tight differential
  pair**, route together, reference a ground plane, keep short.
- Espressif suggests reserving **22/33 Ω series + small cap-to-GND footprints**
  near the chip, and **ESD protection** on the USB lines.
- **CC pins:** 5.1 kΩ pull-downs to GND (one per CC) to advertise as a UFP/sink.

### 6. Antenna / RF
- **Best: hang the module's antenna off the board edge** (feed point at the edge).
- If it must be on-board, keep a **≥15 mm keep-out in all directions** — no copper
  (incl. plane fill), no traces, no parts under/around it. Cut the base board away
  under the antenna if there is one.
- Keep USB, the UART/serial chip, and switching parts away from the antenna.

### 7. PCB layout / stackup
- **Solid ground plane.** On 4-layer, keep one layer a **complete GND plane with
  no signal traces**. On 2-layer, keep the bottom mostly solid GND.
- **Don't carve up the ground plane** with signal traces (the classic beginner
  mistake → bad return paths, EMI, brownouts).
- Decoupling caps close to pins; short return vias.

### 8. Manufacturing / assembly (JLCPCB etc.)
- Use in-stock parts (prefer "Basic"); give critical parts a second source.
- Add **fiducials, mounting holes, test points**, and verify **polarized-part
  rotations** against the assembler's convention before ordering.
- Add a **power LED** and **BOOT/EN buttons or pads** for bring-up.
- Use a module ending in the right silicon rev; for the C3, the MINI-1 module is
  current and JLCPCB-stocked.

---

## How the V4 doorbell measures up

Legend: ✅ meets it · ⚠️ partial / optional gap · ❌ violates · ➖ N/A (module).

| # | Best practice | V4 status | Notes |
|---|---|---|---|
| 1 | ≥500 mA @ 3.3 V supply | ✅ | SGM2212 (~800 mA) off USB 5 V; sized for the WiFi-TX burst |
| 1 | Bulk cap + input protection diode | ✅ | SS14 series Schottky on VBUS; 10 µF C_in |
| 1 | 10 µF on 3V3 + 0.1 µF at module pin | ✅ | 10 µF C_out + 10 µF C_3v3 + 100 nF C_dec on 3V3 |
| 1 | **Avoid AMS1117 / use low-dropout LDO** | ✅ | Deliberately chose **SGM2212** (low dropout) *because* AMS1117's 1.3 V dropout would brown out post-Schottky. **Note: BOM table still lists "U2 AMS1117-3.3" — stale, fix it** |
| 1 | Wide power traces | ✅➖ | Power on inner planes (In1 +3V3 / In2 GND) — width is moot |
| 2 | EN pull-up 10 kΩ + 1 µF | ✅ | C_en is now **1 µF** (Espressif's EN-RC spec value); was 100 nF — bumped 2026-06-07 |
| 3 | GPIO9/BOOT pull-up + button | ✅ | 10 kΩ pull-up + button to GND |
| 3 | GPIO8 pull-up | ✅ | R10 10 kΩ pull-up on IO8 |
| 3 | GPIO2 pull-up (optional) | ⚠️ | **Left floating.** Espressif fn-2 recommends 10 kΩ. Logged as review finding #4 (Minor, optional) |
| 3/4 | Outputs off strapping pins, defined boot state | ✅ | Relays on IO4/IO5 (non-strapping) + 10 kΩ gate pull-downs ⇒ relays default OFF at boot. This is textbook-correct |
| 4 | Avoid internal-flash GPIOs | ✅➖ | Only IO4–IO9, IO18–IO21 used; module hides flash pins |
| 5 | USB D± tight pair over GND | ⚠️ | 4-layer with In2=GND under B.Cu so D± references GND. But D± are **autorouted, not hand-routed as a locked pair** (review #3). FS USB (12 Mbps) tolerates it; hand-route+lock for by-the-book |
| 5 | USB series R + ESD | ✅ | SRV05-4 ESD array on D±; native USB has internal pull-up |
| 5 | CC 5.1 kΩ pulldowns | ✅ | R_cc1/R_cc2 5.1 kΩ each |
| 6 | **Antenna off board edge** | ✅ | U1 overhangs the left edge by 5.4 mm — antenna sits **off-board**. Best-case choice; sidesteps the 15 mm keep-out entirely |
| 6 | No copper/parts under antenna | ✅ | Nothing on board under it (it's off the edge). Just keep no metal enclosure over it (noted in build notes) |
| 7 | Solid GND plane, no signals on it | ✅ | In2 = solid GND, In1 = solid +3V3; signals only on F.Cu/B.Cu. Autorouter forced off the planes (LT_POWER) |
| 7 | Don't carve up the plane | ✅ | Planes kept solid by design; stitch vias offset (no via-in-pad) |
| 8 | In-stock parts, second source | ✅ | LCSC parts mapped; K1/K2 given a second source |
| 8 | Polarized-part rotation check | ✅ | ROT_FIX verified at the Confirm-Placement gate |
| 8 | Power LED + BOOT/EN buttons | ✅ | Power LED on 3V3; BOOT + EN buttons present |
| 8 | Mounting holes | ❌ | **None on the board** (review finding #6). Add some if it gets screwed into an enclosure |
| 8 | Test points | ⚠️ | DESIGN intended TPs for P1–P5/rails/GPIOs/UART; **0 TP footprints actually placed**, GPIO20/21 = NC (review #6) |

### Net assessment
The V4 design is **well above typical first-board quality** and already follows
the rules that actually cause failures — proper LDO sizing (the #1 beginner
brownout trap is *avoided by name*), solid ground/power planes, relays parked on
non-strapping pins with pull-down-defined boot states, native-USB front-end with
ESD + CC resistors, and the antenna pushed off the board edge (the cleanest
possible answer to the 15 mm keep-out rule). Most of the "ESP32 PCB" checklist is
either met or N/A-because-module.

### Worth tidying (none are blockers)
1. **BOM line is stale** — DESIGN's BOM table still says `U2 AMS1117-3.3`, but the
   chosen/justified part is the **SGM2212**. Fix the table so the order matches the
   reasoning.
2. ~~**EN cap** — 100 nF works, but Espressif's spec value is **1 µF**; cheap to bump.~~
   **Done (2026-06-07):** C_en bumped 100 nF → 1 µF.
3. **GPIO2** — add a 10 kΩ pull-up (optional hardening, review #4).
4. **Test points / UART pads** — promised in DESIGN, not on the board (review #6);
   add before ordering if you want bench bring-up against the TV20/S.
5. **Mounting holes** — none; add if it mounts in an enclosure.
6. **USB D± pair** — optional: hand-route + lock for a guaranteed coupled pair.

> Items 2–6 are already tracked in DESIGN.md's *Design review findings*; item 1
> (the AMS1117/SGM2212 BOM mismatch) is the only new discrepancy this comparison
> surfaced.

---

## Sources
- [Espressif — ESP32-C3 Schematic Checklist](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/schematic-checklist.html)
- [Espressif — ESP32-C3 PCB Layout Design](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/pcb-layout-design.html)
- [Espressif — ESP Hardware Design Guidelines (PCB layout, ESP32)](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/pcb-layout-design.html)
- [Espressif — Boot Mode Selection (ESP32-C3, esptool)](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/boot-mode-selection.html)
- [Schemalyzer — ESP32 Hardware Design Guide (2025)](https://www.schemalyzer.com/en/blog/microcontrollers/esp32/hardware-design-guide)
- [espboards.dev — ESP32 Strapping Pins (ESP32/S3/C3/C6)](https://www.espboards.dev/blog/esp32-strapping-pins/)
- [Instructables — Build Custom ESP32 Boards From Scratch (C3/S3)](https://www.instructables.com/Build-Custom-ESP32-Boards-From-Scratch-the-Complet/)
- [RayPCB — ESP32 PCB Design: Best Practices](https://www.raypcb.com/esp32-pcb-design/)
- [JLCPCB — How to Design an ESP32 Module PCB](https://jlcpcb.com/blog/how-to-design-an-esp32-s2-module-pcb)
