# Verification — how to check the board before fab

This is the **procedure** for verifying Klingel V4, not the log of any one run. The
`kicad/doorbell.kicad_sch` / `.kicad_pcb` are authoritative; everything here is a way to
confirm them — the automated gates, an independent schematic review, the bench tests against the
real TV20/S — before committing money to a fab order. Re-run it whenever the schematic or PCB
changes materially.

The aim is to catch the three failure classes that survive ERC/DRC and only show up as a dead or
mis-behaving board: **polarity**, **pin-mapping**, and **pin-usability** (a strapping/input-only
pin used in a way that breaks boot or can't drive its net).

---

## 1. Automated gates

Run `./build.sh all-route` and require it green before anything else — it runs the checks KiCad's
own ERC/DRC can't express and exports the fab outputs from the authoritative files:

- **ERC** — 0 errors. Expect only benign warnings (pin-type "unspecified vs passive/power" on the
  screw terminal / buttons / LDO; the informational `GND`/`P1` same-net note from the deliberate
  P1↔GND bond; cosmetic `lib_symbol_mismatch` if a placed SSR symbol drifted from the cached lib —
  re-sync the symbol and re-run so the schematic pin numbering provably equals the footprint).
- **DRC** — 0/0. Clearances are pinned to JLCPCB capability in `kicad/doorbell.kicad_dru`.
- **`check_pcb.py`** — placement PASS (edge connectors J1/J2 and U1 flush on their board edges;
  parts inside the outline).
- **`route.py`** — 0 unrouted nets; no over-limit copper-thieving float island wide enough to take a
  GND stitching via (too-narrow slivers are accepted).
- **Firmware** — `esphome config firmware/doorbell-v4.yaml` parses clean (needs a `secrets.yaml`
  with `wifi_ssid`/`wifi_password` alongside). Confirm the GPIO assignments in the YAML match the
  schematic.

Green gates verify the files; the `fab/` outputs are exported from them and may lag the
schematic — **re-export (`./build.sh all-route`) before ordering** so the BOM/CPL match.

## 2. Independent schematic review (do it blind)

The strongest check is to reconstruct the board's intent from primary sources **without** reading
DESIGN.md/REQUIREMENTS.md — so the review can't just echo the design's own assumptions. Work only
from:

- the netlist exported from the schematic (`kicad-cli sch export netlist`),
- the manufacturer datasheets (see §6),
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
- The on-board latch relay (K5) replicates the handset's seal-in: coil across **P1↔P4** (+ on the
  +12 V P4 side), NO contact feeding the common back to P4. Confirm contact mapping and flyback
  diode orientation.
- Confirm the door pair reproduces S1's **break-before-make**: the NC seal-in-break opens before
  the door bridge closes (RC-delayed), and the max-on-time one-shot releases the bridge in bounded
  time (DOOR-4 / DOOR-5). Cross-check the timing in `sim/test`.

**Diodes / polarity** — confirm every diode against the **library pin-1 convention** (1N4148W
pin 1 = cathode in the CDFER JLCPCB lib) and its role: opto reverse-clamps anti-parallel across
their LEDs, the latch-coil flyback reverse-biased in normal operation, the VBUS series Schottky
passing VBUS, the VBUS TVS reverse-biased below its stand-off.

**USB-C + ESD** — CC1/CC2 each have a 5.1 kΩ **Rd** to GND (sink/UFP, both orientations); the ESD
clamp is **flow-through** (connector on the _In side, ESP on _Out) with VCC biased from fused VBUS;
**no D+/D− swap** anywhere connector→clamp→GPIO; the fuse sits **upstream** of the TVS and LDO so a
clamp event blows the fuse (fail-safe).

**Power** — LDO pinout correct; input (VBUS − Schottky) leaves dropout headroom for the WiFi-TX
peak; C_in/C_out within the LDO's stable range.

**MCU** — check **every module pad against the datasheet pinout and the GPIO map in DESIGN.md**
(power/USB/I²S/I²C/SSR-drive/sense). Strapping pins must sit at valid levels at reset; no
input-only or flash-tied pin may be misused. Native USB D±/Serial-JTAG is the flash+log path.

**Codec + audio coupling** — all pins + EP map to the datasheet; I²S direction correct (ASDOUT→ESP
DIN, DSDIN←ESP DOUT); CE strap sets the I²C address; the tap is **transformer-less** and
AC-coupled — TX is `DAC → DC-block → R (2.2 kΩ) → line 3` (the handset's talk-strap value), RX a
differential sense of line 2; line 3 is high-Z at idle (gated by the dual talk SSR).

**Bell sense** — opto LEDs hardwired **anode → bus line, cathode → R_lim → P1**; anti-parallel
clamps limit reverse LED voltage; collectors held high by external pull-ups (firmware `mode:
input`). Confirm the sense margin: the collector low level sits well under the ESP V_IL across the
expected line voltage and the opto's CTR spread.

**Passive WF26 core** — the `WF26_*` parts reproduce the handset's door-release / talk / gong /
seal-in topology, so the board behaves like a plain WF26 unpowered (the SSRs/codec/optos are
additive on top). Confirm against `wf26/wf26.kicad_sch`.

## 4. Cross-checks against external references

- **Netlist vs the handset** — extract `wf26/wf26.kicad_sch` with `kicad-cli` and confirm the bus
  pin map, the door/talk split (door = direct P2↔P3 short; talk = 2.2 kΩ P4↔P3), the K5 coil across
  P1↔P4, and that the chime-mute sits in the C1 audio path (P4↔C1), not in line 4.
- **Intercom logic vs the TV20/S plan** — Türruf ≈ 12 VDC across terminals 4 & 1; ÖT bridges
  terminals 2 & 3; Etagenruf series-interrupts line 5; door ring = 3-chime gong, floor call =
  continuous tone. The session is held from P2 and ends via a P2 transition (door-open transfer or
  the ~60 s timeout) — cross-check against the `captures/runs/` bench captures.
- **Datasheet pinouts** — for any part whose pinout is image-only or sourced by proxy (e.g. an opto
  confirmed by PC817-family convention rather than its own sheet), confirm against the actual
  manufacturer datasheet before fab; an emitter/collector or pin-1 swap is a silent dead-channel.

## 5. Decision-worthy classes of finding to watch for

These are the kinds of issue this review exists to surface — judgement calls, not pass/fail:

- **Isolation deviation.** P1 is hard-bonded to board GND (no galvanic barrier) — a deliberate,
  measurement-justified SAFE-3 deviation. Confirm the TV20/S common is safe to bond to USB/PC
  ground and that no bus conductor floats at a mains-referenced potential; containment then rests
  on per-tap protection + the sacrificial F1 fuse (SAFE-7).
- **Electrolytic polarity vs the handset readout.** The gong cap's "+" follows the +12 V P4 side —
  **bench-confirmed on the genuine WF26 (+→P4, −→P5)**, matching both the wf26 reverse-engineered
  schematic (C1.1+ → P4) and the V4 board (C19). Only an early +→P5 hand-assumption was wrong.
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
on the P2 feed, an isolated/battery 2-ch scope, a DMM, and the board's own USB-C 5 V (via a current
meter if available). **Ground discipline:** P1 is hard-bonded to board GND *and* USB GND, so
`PSU− = P1 = USB-GND = scope-ground` is **one node** — float the PSU, isolate the scope, grounds on
P1 only; never tether a mains-earthed PC scope and PC-USB at once (the §6 isolation rule).

**Stage 0 — power-off continuity (DMM).** P1↔GND ≈ 0 Ω (the deliberate bond); no short P2/P3/P4/P5 to
each other or P1 (**P4↔P1 reads the K5 coil**, not a fault); USB VBUS↔GND not a dead short; F1
continuous; TP1/TP2/TP3 present; C19 "+" toward P4.

**Stage 1 — local power only, no bus.** USB-C 5 V → **TP2 ≈ +4.5–5 V** (after the SS14 drop),
**TP3 ≈ +3.30 V**, quiescent current sane, board boots/joins WiFi/logs clean. **SAFE-6:** idle, then
toggle each SSR from HA and confirm the contact flips at the pads — K1/K2 (NO) **open**, K3/K4 (NC)
**closed** — validating each SSR + driver + GPIO map with no bus voltage present.

**Stage 2 — emulated bus** (`PSU+ → 100 Ω → P2`, `PSU− → P1`, 12 V, limit ~120 mA):
- **2a passive seal-in, board UNPOWERED (MODE-1/SAFE-4):** tap 12 V onto P4 ~1 s → K5 pulls in;
  release → confirm it **seals in** (P4 holds just under P2); pull P2 to 0 → K5 drops.
- **2b ring sense, powered:** 12 V on P4 → "House Doorbell" asserts (clears on removal); 12 V on P5 →
  Etagenruf/OC2 asserts; non-detect ⇒ swap that LED's two bus connections (silent, not damage).
  **Cross-stress:** drive P4 high, confirm the idle OC2 cathode stays clamped near 0 (per-opto
  limiter + D9 fix).
- **2c door open (DOOR-4/5):** seal in, fire a door-open, 2-ch scope the seal-in node vs the P2↔P3
  bridge — **K4 opens ~20 ms before K2 closes** (latch drops, P4 falls, live P4 never reaches P3);
  hold the command asserted → K2 still releases after **~6.7 s** (watchdog).
- **2d chime-mute (GONG-1/4):** inject an AC tone on P4 → present at the speaker (P5↔P1) with K3
  closed, gone when mute asserts, P4/latch/sense untouched; a tone on P5 reaches the speaker
  regardless of mute.
- **2e audio (partial):** RX — inject P2↔P1 and confirm the codec ADC sees it through the −18 dB divider,
  that a gong-level drive stays inside the codec rail [0, AVDD] (abs-max), and the signal lands on MICP
  with MICN held at VMID; TX — assert talk, drive a DAC tone, scope it on P3 through R28, confirm high-Z
  when talk is off.

**Stage 3 — protection, last and current-limited (SAFE-2):** with the limit still low, deliberately
reverse P2/P1 (and a mis-order or two), confirm the per-tap clamps/TVS hold and the board survives and
still works once correct wiring is restored — F1 only protects the USB side, the bus taps rely on
per-tap protection.

This proves power, default-safe states, sense + polarity, the full latch seal-in/drop mechanics, the
door break-before-make timing, the watchdog and chime-mute — every board property that does **not**
depend on a TV20/S response. The responses that do (TX-out reach, opener firing, real gong/levels/hum,
the timeout P2-sink and shared-bus interactions) carry over to §6.

## 6. Bench verification against the real TV20/S

Some claims can only be settled on hardware. Probe via the commissioning test points (TP1 = GND
anchor, TP2 = +5V, TP3 = +3V3), J2's screws, and component pads. Use an **isolated** scope
(grounds on P1 only; don't tether a mains-earthed PC) — see `TODO.md` "Bench measurements" and the
`captures/runs/` capture procedure.

- **Per-channel opto polarity** — ring each real bell and confirm detection (or the ~10.7 V drop
  across R_lim). A wrong guess is a silent non-detect, not damage; swap the LED's two bus
  connections for that channel.
- **Door pulse / chime suppress / session sense** — confirm the opener fires, the gong mutes with
  line 4 / the latch / the Etagenruf untouched, and OC1 tracks the session edge-to-edge.
- **Break-before-make** — confirm a board door-open drops the latch (line 4 falls, P2 rises) as on
  the genuine S1; confirm the watchdog releases the bridge if the drive is held.
- **⚠ TX-out reach (open)** — confirm the TV20/S forwards the line-3 audio to the door station once
  it sees the R28 2.2 kΩ handshake bridge, at a usable level (AUDIO-2/AUDIO-6). This is the
  prerequisite for the full-duplex AUDIO-3 MAY and the main open question — see DESIGN.md
  "Audio path".
- **Hum / RX level** with the P1↔GND bond once RX is live; set the codec digital volume so TX
  doesn't overdrive the TV20/S amp.

## 7. Datasheet sources to consult

Local copies live in `docs/` so the references don't rot: the ESP32-S3-WROOM-1U-N16R8 module (pad map +
strapping), ES8311 codec, SGM2212 LDO, TPD2S017 USB ESD, Omron G6K relay, SUPSiC GAQY412E/EH and
GAQW/GAQY212GS PhotoMOS, the PC817-family opto convention (proxy for the LTV-217), and the STR
TV20/S Verdrahtungsplan + Fehlersuchhilfe. SS14, SMF5.0A, 1N4148W and the USB-C jack are reasoned
from standard pin conventions, cross-checked against the project's JLCPCB symbol pads.
