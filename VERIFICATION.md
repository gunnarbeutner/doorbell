# Verification — how to check the board before fab

This is the **procedure** for verifying a board before fabrication, not the log of any one run. The
`kicad/doorbell.kicad_sch` / `.kicad_pcb` are authoritative; everything here is a way to
confirm them — the automated gates, an independent schematic review, the bench tests against the
real TV20/S — before committing money to a fab order. Re-run it whenever the schematic or PCB
changes materially.

The aim is to catch the three failure classes that survive ERC/DRC and only show up as a dead or
mis-behaving board: **polarity**, **pin-mapping**, and **pin-usability** (a strapping/input-only
pin used in a way that breaks boot or can't drive its net).

---

## 1. Automated gates

Run `./build.sh verify` and require it green before anything else — it runs the checks KiCad's
own ERC/DRC can't express and exports the fab outputs from the authoritative files:

- **ERC** — 0 errors. Expect only benign warnings (pin-type "unspecified vs passive/power" on the
  screw terminal / buttons / LDO; the informational `GND`/`P1` same-net note from the deliberate
  P1↔GND bond; cosmetic `lib_symbol_mismatch` if a placed SSR symbol drifted from the cached lib —
  re-sync the symbol and re-run so the schematic pin numbering provably equals the footprint).
- **DRC + schematic parity** — 0/0. The gate uses `--exit-code-violations` so any unexcluded
  violation fails the build, and `--schematic-parity` so a PCB that has drifted from the schematic
  also fails. Clearances are pinned to JLCPCB capability in `kicad/doorbell.kicad_dru`.
- **`check_pcb.py`** — placement PASS (edge connectors J1/J2 and U1 flush on their board edges;
  parts inside the outline).
- **`route.py`** — 0 unrouted nets; no over-limit copper-thieving float island wide enough to take a
  GND stitching via (too-narrow slivers are accepted).
- **Firmware** — `esphome config firmware/doorbell.yaml` parses clean (needs a `secrets.yaml`
  with `wifi_ssid`/`wifi_password` alongside). Confirm the GPIO assignments in the YAML match the
  schematic.

Green gates verify the files without rewriting generated artifacts. The `fab/` outputs may lag the
schematic — **run `./build.sh` before ordering** to repeat verification and export a matched release
set so the Gerbers, BOM, CPL, PDF and STEP agree.

## 2. Independent schematic review (do it blind)

The strongest check is to reconstruct the board's intent from primary sources **without** reading
DESIGN.md/REQUIREMENTS.md — so the review can't just echo the design's own assumptions. Work only
from:

- the netlist exported from the schematic (`kicad-cli sch export netlist`),
- the manufacturer datasheets (see §7),
- the reverse-engineered handset (`wf26/wf26.kicad_sch` + `wf26/wf26-schematic.md`),
- the STR TV20/S service plan (`docs/design/STR_TV20S_Schaltplan_Fehlersuchhilfe.pdf`).

Derive what each net *should* be, then compare to the schematic. Reconcile any disagreement with
DESIGN.md only **after** forming the independent view. Every active and polarity-sensitive part
gets checked against its datasheet for polarity, pin-mapping and pin-usability.

## 3. What to check, by subsystem

For each item, confirm against the datasheet and the netlist — don't restate values from the
schematic, read them from it.

**Switches / SSRs / latch relay**
- Each PhotoMOS SSR is the intended **form**: the talk/door gates idle **open** (1-Form-A, NO),
  the chime-mute and seal-in-break idle **closed** (1-Form-B, NC). Idle states must be fail-safe
  (no talk/door at boot; gong rings at boot; latch stays sealed) — see SAFE-6 / GONG-3 / DOOR-4.
- SSR LED drive: series R sets I_F into the part's datasheet window; gate pull-downs hold every
  SSR off while the GPIO floats at boot.
- The on-board latch relay (K5) replicates the handset's seal-in: coil across **P1↔K5_LATCH**, with
  normally-closed K6 passing raw P4 at rest; the primary NO contact seals `K5_LATCH` from P2. Confirm
  the auxiliary NO contact grounds `K5_SENSE_N`, gates K6's LED return and cannot open K6 before K5
  physically pulls in. Confirm contact mapping and flyback-diode orientation.
- Confirm the door pair reproduces S1's **break-before-make**: the NC seal-in-break opens before
  the door bridge closes (RC-delayed), and the max-on-time one-shot releases the bridge in bounded
  time (DOOR-4 / DOOR-5). Cross-check the timing in `sim/test`.

**Diodes / polarity** — confirm every diode against the **library pin-1 convention** (1N4148W
pin 1 = cathode in the CDFER JLCPCB lib) and its role: opto reverse-clamps anti-parallel across
their LEDs, the latch-coil flyback reverse-biased in normal operation, the VBUS series Schottky
passing VBUS, the VBUS TVS reverse-biased below its stand-off.

**USB service inlet + ESD** — J1 pin order is VBUS/D−/D+/GND; D4 points from raw VBUS into
VBUS_PROTECTED and blocks reverse input/back-feed. The ESD clamp is **flow-through** (connector on
the _In side, ESP on _Out) with VCC biased from fused +5V;
**no D+/D− swap** anywhere connector→clamp→GPIO; the fuse sits **upstream** of the TVS and LDO so a
clamp event blows the fuse (fail-safe).

**Power** — LDO pinout correct; input (VBUS − Schottky) leaves dropout headroom for the WiFi-TX
peak; C_in/C_out within the LDO's stable range.

**MCU** — check **every module pad against the datasheet pinout and the GPIO map in DESIGN.md**
(power/USB/I²S/I²C/SSR-drive/sense). Strapping pins must sit at valid levels at reset; no
input-only or flash-tied pin may be misused. Native USB D±/Serial-JTAG is the flash+log path.
Confirm IO5 is ADC1_CH4 and not a strapping pin. Trace the post-fuse monitor as
`+5V → R40 100 kΩ → VBUS_F_ADC → R41 10 kΩ → GND`, with C25 (100 nF) from the ADC node to GND;
the 11:1 ratio must keep the ADC node below 0.84 V even at D10's 9.2 V maximum clamp voltage.

**Codec + audio coupling** — all pins + EP map to the datasheet; I²S direction correct (ASDOUT→ESP
DIN, DSDIN←ESP DOUT); CE strap sets the I²C address; the tap is **transformer-less** and
AC-coupled. Trace TX explicitly: `OUTP → R26 (2.2 kΩ) → C14 → TALK_BRIDGE → R28 (2.2 kΩ) →
TX_OUT → K1-ch2 → P3`; K1-ch1 applies the P2 handshake to `TALK_BRIDGE`. Confirm factory-bridged
JP3 and R38+R39 (100 kΩ each) form a 200 kΩ P2-to-`TALK_BRIDGE` precharge across K1-ch1, with a
nominal `(200 kΩ + R26) × C14 ≈ 202 ms` time constant. RX is a differential sense of line 2.
K1-ch2 must keep line 3 high-Z at idle despite the always-present precharge path.

Check the external codec clamps by pin number, not only by symbol appearance: D13/D14 pin 1
(cathode) → AVDD and pin 2 (anode) → OUTP/MIC1P; D16/D17 pin 1 → OUTP/MIC1P and pin 2 → GND.
D18 pin 2 (anode) faces U4 `AVDD_PRE`, pin 1 (cathode) faces AVDD, and R37 is 220 Ω AVDD→GND.
Confirm the exact diode sheet covers reverse voltage and the actual injection current; distinguish
its guaranteed 25 °C VF limit from any 0–50 °C estimate. Simulate both polarities of the full bus
envelope with the board unpowered, including sustained C14-short, and require AVDD to remain below
codec turn-on without raising +5 V or +3V3.

**Bell sense** — opto LEDs hardwired **anode → bus line, cathode → R_lim → P1**; anti-parallel
clamps limit reverse LED voltage; collectors held high by external pull-ups (firmware `mode:
input`). Confirm both active-low and idle-high margins across the expected line voltage, pull-up
tolerance and optocoupler CTR/dark-current spread. Record the assumed enclosure temperature range
and distinguish guaranteed datasheet limits from engineering estimates based on typical curves.

**Passive WF26 core** — the `WF26_*` parts reproduce the handset's door-release / talk / gong /
seal-in topology, so the board behaves like a plain WF26 unpowered (the SSRs/codec/optos are
additive on top). Confirm K6 is normally closed without board power and JP2 is open by default, then
compare the underlying handset behaviour against `wf26/wf26.kicad_sch`.

## 4. Cross-checks against external references

- **Netlist vs the handset** — extract `wf26/wf26.kicad_sch` with `kicad-cli` and confirm the bus
  pin map, the door/talk split (door = direct P2↔P3 short; talk = 2.2 kΩ P4↔P3), the K5 coil across
  P1↔P4, and that the chime-mute sits in the C1 audio path (P4↔C1), not in line 4.
- **Intercom logic vs the TV20/S plan** — Türruf ≈ 12 VDC across terminals 4 & 1; ÖT bridges
  terminals 2 & 3; Etagenruf series-interrupts line 5; door ring = 3-chime gong, floor call =
  continuous tone. The session is held from P2 and ends via a P2 transition (door-open transfer or
  the ~60 s timeout) — cross-check against the `captures/runs/` bench captures.
- **Datasheet pinouts** — for any part whose pinout is image-only or sourced by proxy, confirm against the actual
  manufacturer datasheet before fab; an emitter/collector or pin-1 swap is a silent dead-channel.

## 5. Decision-worthy classes of finding to watch for

These are the kinds of issue this review exists to surface — judgement calls, not pass/fail:

- **Isolation deviation.** P1 is hard-bonded to board GND (no galvanic barrier) — a deliberate,
  measurement-justified SAFE-3 deviation. Confirm the TV20/S common is safe to bond to USB/PC
  ground and that no bus conductor floats at a mains-referenced potential; containment then rests
  on per-tap protection + the sacrificial F1 fuse (SAFE-7).
- **Electrolytic polarity vs the handset readout.** Establish the genuine handset's gong-capacitor
  polarity with a meter and confirm that the schematic, footprint and assembly orientation match it.
- **Pinouts confirmed by proxy** (see §4) — flag any part not yet checked against its own sheet.
- **Single-ended TX off OUTP.** The codec's differential negative half is AC-terminated, not
  driven — functionally fine, but the lever if the line-3 drive level proves marginal.

## 5.5 Bench bring-up with an emulated bus (before the real TV20/S)

Settle the board's own behaviour on the bench with a **current-limited PSU standing in for the
bus** before risking the real intercom. The TV20/S is, electrically, a current-limited standing
**+12 V rail on P2** (source impedance ~90 Ω — it sags 12 → 9.4 V under the ~29 mA seal-in load) plus
**~1 s +12 V pulses on P4/P5** for rings. A bench PSU at 12 V through a **~100 Ω series R into P2**
with a **low current limit** emulates both and adds a fault backstop the real bus doesn't. Everything
except the central's *active responses* (opener firing, gong tone, TX-out forwarding, timeout sink —
those are §6) can be exercised this way.

**Rig:** floating PSU (2-ch ideal, or 1-ch + a momentary button for the ring tap), a ~100 Ω resistor
on the P2 feed, an isolated/battery 2-ch scope, a DMM, and the board's own J1 5 V feed (via a current
meter if available). Flash `firmware/doorbell-bench.yaml` for these stages — the production
config minus the HA events (a bench ring would fire the real automations) plus direct debug
controls for K3, the door drive and K6 isolation, plus a diagnostic K5-contact input. **Ground
discipline:** P1 is hard-bonded to board GND *and* USB GND, so
`PSU− = P1 = USB-GND = scope-ground` is **one node** — float the PSU, isolate the scope, grounds on
P1 only; never tether a mains-earthed PC scope and PC-USB at once (the §6 isolation rule).

**Stage 0 — power-off continuity (DMM).** P1↔GND ≈ 0 Ω (the deliberate bond); no short P2/P3/P4/P5 to
each other or P1 (**P4↔P1 reads the K5 coil**, not a fault); USB VBUS↔GND not a dead short; F1
continuous; raw P4↔`K5_LATCH` continuous through K6; JP2 open; JP3 factory-bridged and, after
capacitors settle, P2↔`TALK_BRIDGE` ≈ 200 kΩ through R38+R39; `VBUS_F_ADC`↔GND ≈ 10 kΩ through
R41; TP1–TP8 present; C19 "+" toward P4.

**Stage 1 — local power only, no bus.** J1 VBUS at 5 V → the 5 V rail **≈ +4.5–5 V at D4's cathode**
(after the SS14 drop — there is no 5 V test point), `VBUS_F_ADC ≈ +5V / 11` (about 0.41–0.45 V),
and the firmware's **Post-Fuse 5 V Supply** reading agrees with a DMM on +5V within ADC/resistor
tolerance. A complete supply or fuse loss cannot be reported because it also powers down the ESP32.
**TP2 ≈ +3.30 V**, quiescent current sane, board boots/joins WiFi/logs clean. **SAFE-6:** idle, then
  toggle each SSR from HA and confirm the contact flips at the pads — K1/K2 (NO) **open**, K3/K4 (NC)
  **closed** — validating each SSR + driver + GPIO map with no bus voltage present. Leave
  `Debug P4 Isolation` off; confirm GPIO48/`P4_ISO` is low and K6 remains closed. Do not exercise
  K6 until the passive K5 checks in 2a have passed. Record the 5 V, +3V3, codec VMID and idle-output
  voltages in the run-specific evidence log.

**Stage 2 — emulated bus** (`PSU+ → 100 Ω → P2`, `PSU− → P1`, 12 V, limit ~120 mA):
- **2a passive seal-in, board UNPOWERED (MODE-1/SAFE-4):** tap 12 V onto P4 ~1 s → K5 pulls in;
  release → confirm it **seals in** (`K5_LATCH` and raw P4 hold just under P2 through closed K6);
  pull P2 to 0 → K5 drops.
  Measure pull-in, sealed current/voltage and drop-out voltage; compare all three against the relay
  datasheet and the real-bus operating range.
- **2b ring sense, powered:** 12 V on P4 → "House Doorbell" asserts (clears on removal); 12 V on P5 →
  Etagenruf/OC2 asserts; non-detect ⇒ swap that LED's two bus connections (silent, not damage).
  Verify collector LOW/HIGH against the MCU's V_IL/V_IH limits, including long tone gaps and composed
  input states.
  **Cross-stress:** drive P4 high, confirm the idle OC2 cathode stays clamped near 0 (per-opto
  limiter + D9 fix).
- **2c door open (DOOR-4/5):** seal in, fire a door-open, 2-ch scope the seal-in node vs the P2↔P3
  bridge — measure K4 break before K2 make and compare with the current ~38 ms nominal delay
  (latch drops, P4 falls, live P4 never reaches P3);
  hold the command asserted and measure that the watchdog releases K2 after the minimum normal
  firmware pulse but before the specified maximum fault-on time.
- **2d K5-confirmed P4 isolation:** keep JP2 open and power the bench firmware. Before K5 pull-in,
  confirm `Debug K5 Sense` is clear, turn on `Debug P4 Isolation` and verify GPIO48/`P4_ISO` goes
  high but the hardware interlock keeps K6 closed; turn the request off. Ring K5 in and confirm
  `Debug K5 Sense` asserts after its 5 ms debounce. Turn on `Debug P4 Isolation`, verify K6 opens,
  remove the raw-P4 drive and confirm K5 remains sealed from P2 while raw P4 is disconnected from
  `K5_LATCH`. Drop P2 and confirm K5 releases, the diagnostic clears and K6 immediately restores
  continuity even while the request remains high; then turn the request off. Finally bridge JP2
  temporarily and confirm it restores permanent P4↔`K5_LATCH` continuity.
- **2e chime-mute (GONG-1/4):** inject an AC tone on P4 → present at the speaker (P5↔P1) with K3
  closed, gone when mute asserts, P4/latch/sense untouched; a tone on P5 reaches the speaker
  regardless of mute.
- **2f audio (partial):** RX — inject P2↔P1 and confirm the codec ADC sees it through the −18 dB divider,
  that a gong-level drive stays inside the codec rail [0, AVDD] (abs-max), and the signal lands on MICP
  with MICN held at VMID; TX — assert talk, drive a DAC tone, scope it on P3 through the TX resistor,
  confirm the populated reference and net from the schematic rather than assuming a revision-specific
  designator, and confirm high-Z
  when talk is off.

**Stage 3 — connector polarity, before energising (SAFE-2):** use continuity mode to verify J2 follows
the documented P1–P5 wire order and confirm C19 pin 1 (+) faces P4 through K3. Do not deliberately
mis-order the bus: the protected taps are bidirectional, but the field-proven WF26 crossover is polarized.

Do not proceed until these checks prove power, default-safe states, sense and polarity, latch
seal-in/drop mechanics, door break-before-make timing, watchdog operation and chime suppression.
The responses that depend on a TV20/S (TX-out reach, opener firing, real gong/levels/hum, timeout
sink and shared-bus interactions) carry over to §6.

## 6. Bench verification against the real TV20/S

Some claims can only be settled on hardware. Probe via the commissioning test points (TP1 = GND
anchor, TP2 = +3V3, TP3–TP8 = watchdog gate + codec taps — net per test point in the schematic),
J2's screws, and component pads. Use an **isolated** scope
(grounds on P1 only; don't tether a mains-earthed PC) — see `TODO.md` "Bench measurements" and the
`captures/runs/` capture procedure.

- **Per-channel opto polarity** — ring each real bell and confirm detection (or the ~10.7 V drop
  across R_lim). A wrong guess is a silent non-detect, not damage; swap the LED's two bus
  connections for that channel.
- **Door pulse / chime suppress / session sense** — confirm the opener fires, the gong mutes with
  line 4 / the latch / the Etagenruf untouched, OC1 reports raw P4, and `K5_SENSE_N` reports actual
  relay pull-in/release.
- **Break-before-make** — confirm a board door-open drops the latch (line 4 falls, P2 rises) as on
  the genuine S1; hold the command and verify the watchdog timeout against the requirements.
- **Chime-suppress transitions** — charge the gong coupling network from a real ring, open K3, end
  the ring/session, then sweep K3 reclose delays from zero through the nominal bleed interval while
  monitoring P4, OC1 and K5. Require no false detection or relay pull-in at every delay. Include
  reset/brownout as an immediate-reclose case. If a passive bleed is fitted, confirm that the residual
  pulse decreases with wait time; a delayed pass is not a substitute for the zero-delay test.
- **TX-out reach** — confirm the TV20/S forwards line-3 audio to the door station once it sees the
  schematic's talk-handshake resistance, at a usable level (AUDIO-2/AUDIO-6).
- **TX-precharge transitions** — with JP3 bridged, scope P3 and `TALK_BRIDGE` across repeated K1
  make/break cycles using a zero-valued digital stream before repeating with the welcome sample.
  Check both a long-idle first assertion and rapid turnarounds; require the residual step to meet
  BUS-2, not actuate any bus function and not mask the start of speech. Only if diagnosis requires an
  A/B comparison, cut JP3, repeat the identical captures, then restore the factory bridge. Record the
  result as V4.2 evidence; the V4.1 bench board does not prove this changed network.
- **Hum / RX level** with the P1↔GND bond once RX is live; set the codec digital volume so TX
  doesn't overdrive the TV20/S amp.
- **Session load** — measure the board's sealed current and bus voltage against the stock WF26,
  then confirm session behaviour (gong, opener and timeout) across that difference.

## 7. Datasheet sources to consult

Local copies live in `docs/` so the references don't rot: the ESP32-S3-WROOM-1U-N16R8 module (pad map +
strapping), ES8311 codec, SGM2212 LDO, TPD2S017 USB ESD, Omron G6K relay, SUPSiC GAQY412E/EH and
GAQW/GAQY212GS PhotoMOS, the AO3400A door/watchdog FETs, the LMBR01S30ST5G codec-clamp Schottky, the
Toshiba TLP293 GB low-current sense optocoupler, Panasonic EEEFK1H220P crossover capacitor,
R+O / Zhuhai Hongjiacheng 1N4004W flyback/clamp, SS14, SMF5.0A, 1N4148W, JST-SH connector, and the
STR TV20/S Verdrahtungsplan + Fehlersuchhilfe.

For every ordered part, use the exact datasheet corresponding to the BOM/LCSC entry. Record
the symbol pin, footprint pad, physical package pin and net for each polarity-sensitive or active
device. Recalculate all timing and threshold claims from the ordered part's guaranteed ranges; do
not carry a previous board's pinout or measured timing forward as evidence.

## 8. Mechanical enclosure verification

Fit the fully populated height envelope—preferably a first article or an accurate printed STEP—into
the real enclosure. Verify outline and boss clearance, closed-lid Z clearance, speaker/grille and
wire-entry alignment, connector access, and full actuation of both housing buttons. Record photos,
measurements and the exact board revision in a separate run-specific evidence file.
