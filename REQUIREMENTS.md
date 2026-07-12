# Doorbell controller — Requirements

What the board must do. This is the *what*; **DESIGN.md** is the *how* (architecture, pin map,
relays, audio path) and is authoritative for the circuit. Keep the two in sync: a requirement
change here should be reflected in DESIGN.md, and vice-versa.

Requirement levels follow RFC 2119: **MUST** = mandatory, **SHOULD** = strong default (deviation
needs a reason), **MAY** = optional.

## Context & terminology

The board is a smart interface to a **TCS TV20/S** apartment-intercom bus (5-wire, NTR201
230 V→12 VAC). It replaces or augments a **WF26** apartment handset. The smart layer is an ESP32
(ESPHome). See DESIGN.md "System context" for the full picture.

**Three units, kept distinct** (more than one thing on the bus could loosely be called a "station", so
we don't use the bare word): the **TV20/S** (a.k.a. the **central unit** — the central control box that
supplies the bus, pulses line 4 for ~1 s to start a call, and runs the door opener and the ~60 s
timeout); the **handset** (the apartment **WF26**/Sprechstelle — the board emulates or replaces one);
and the **door station** (the building-entrance unit — call button + mic/speaker, the far end of the
speech path). A bus tap on line 4 (the board, or a handset) is an **endpoint**.

**Deployment scope:** line 4 (front-door / Türruf) is a **private line** — the board is the single
endpoint at the WF26 tap (**replacement-only**: the board *is* the handset, carrying its own passive
WF26 core; it does not run in parallel with a separate handset). The speech pair (lines 1/2/3) is a
shared party line across apartments.

| Term | Meaning | Bus line |
|------|---------|----------|
| **Front-door call** | *Türruf* — the building/house door (Haustür); ~12 V DC gong pulse | Line 4 |
| **Apartment-door call** | *Etagenruf* — the apartment's own floor/landing door | Line 5 (across 5↔1) |
| **Speech pair** | half-duplex audio: listen = line 2, talk = line 3, ref = line 1 | Lines 1/2/3 |
| **Passive WF26 core** | the handset circuit reproduced on-board (the `WF26_*` parts) — the unpowered fallback | — |

---

## MODE — Deployment modes

- **MODE-1 (MUST)** Replace the WF26 outright, and with **no board power** fall back to the WF26's
  own behaviour — the smart layer is strictly *additive*, so an unpowered or failed board is still a
  working handset. Unpowered, specifically:
  - **MODE-1a (MUST)** the physical **buttons work** — door release and talk.
  - **MODE-1b (MUST)** **incoming and outgoing audio both work** — passive listen (line 2 →
    transducer) and talk (transducer-as-mic → line 3, via the talk button), with no ESP/codec involved.
  - **MODE-1c (MUST)** **chime suppression is disabled** → the front-door gong rings (suppression
    needs power; see GONG-3).
- **MODE-2 (MUST)** **Exactly one passive WF26 is always in the loop** — the board's own hardwired
  core. The board *replaces* the handset; there is **no parallel mode** (running alongside a separate
  WF26 isn't supported — chime-suppress would have to break line 4 in series with that handset, which
  conflicts with keeping its session alive; see DESIGN.md). So the board must present a
  **WF26-equivalent** load to the shared bus, not an additional one (BUS-1).
- **MODE-3 (MUST)** **Powered, the smart actuators mirror the handset's *behaviour*, not merely its
  function.** Where an SSR stands in for a handset switch (door ↔ S1, talk ↔ S2), it MUST reproduce the
  **full** behaviour of that switch — including its effect on the **session / latch** — not just the
  minimal bus signal that triggers the function. A handset switch can do several things in one motion
  (S1 both fires the opener *and* ends the session by dropping the WF26 latch); the smart stand-in MUST
  do **all** of them, so an app action is indistinguishable from the equivalent physical button press.
  This is the powered counterpart to MODE-1's additive/fallback rule. (Concrete case: DOOR-4.)

## BUS — bus loading & compatibility

- **BUS-1 (MUST)** On **every** bus line, the board MUST NOT draw more current — or present a heavier
  load — than a stock WF26 does; ideally (SHOULD) it presents the *same* load the WF26 does. The
  passive core matches by construction; the smart additions are the only things beyond it, and each
  MUST stay negligible against the stock load:
  - **sense optos** tap high-Z and only on an active line (~2 mA off a ringing line, far below the
    WF26's own ~37 mA Türruf-relay coil);
  - the **audio tap** is AC-coupled (DC-blocked) and high-Z (AUDIO-4) — no DC load, negligible AC load
    across the speech pair;
  - the **SSRs** default open (SAFE-6) — nothing added at rest.

  (BUS-1 is about presenting a WF26-equivalent load to the *shared* bus — other apartments share lines
  1/2/3.)

- **BUS-2 (MUST)** Any conductive path the board **adds or engages** between bus lines, or between a
  board-side source and a bus line (the K1 talk/handshake bridge, the K2 door bridge, the latch
  seal-in, the codec TX network), MUST NOT deliver signals **unintended for the destination** at a
  disturbing level — in **every reachable composed state**: each measured bus scenario (ring + gong,
  held session, neighbour activity, door-open — `captures/runs/`) combined with each actuator state
  (SSR / switch / latch position) the firmware or the bus can produce. Quantified:
  - **(a) Function degradation:** at any node where the board delivers an intended signal, every
    unintended contributor arriving through a board-created or board-engaged path stays **≥ 20 dB
    below the intended signal** at that node.
  - **(b) Actuation:** signals forwarded through board paths stay below the level that actuates any
    bus function or board sense (door release, ring/session detection) — the outbound counterpart of
    RING-4.
  - **(c) Transitions count as signals:** steps from the board's own state changes (a contact
    making/breaking into a charged coupling network, the codec output stage enabling) are held to
    the same two limits.

  BUS-2 is deliberately **stricter than WF26-equivalence** (MODE-2): the board's bridges are
  electrically identical to the handset's switches, but firmware engages them in compositions a human
  never would (a talk bridge at t = 0 of every ring, when the gong is guaranteed live) — path
  equivalence does not imply timing equivalence. *(Realised by K5-confirmed K6 isolation of raw P4
  (a), the R28 = 2.2 kΩ handshake remaining distinct from a door short (b), and the K4↔K2
  break-before-make (c); the
  codec cold-start step (c) is bench-gated — see DESIGN.md "Audio path" ("TX front-end", "Gong ↔ TX
  handshake") and "Door-open mirrors S1".)*

## RING — Ring detection

- **RING-1 (MUST)** Detect an incoming call (a ring), and expose it to the ESP/firmware.
- **RING-2 (MUST)** Distinguish a **front-door (Türruf, line 4)** call from an **apartment-door
  (Etagenruf, line 5)** call.
- **RING-3 (MUST)** Ring detection MUST keep working while the gong is being suppressed (GONG-1) —
  the incoming Türruf is sensed *before* the suppression point.
- **RING-4 (MUST)** Detection MUST reject bus cross-talk so it does not raise phantom calls — in
  particular a PTT/talk bridge or speaker/session audio on the sensed lines must not be reported as a
  ring (and must never trigger the door opener). *(Realised in firmware masking, DESIGN.md
  "Bell / session sense front-end".)*
- **RING-4a (MUST)** Chime-suppression state changes MUST NOT create a new ring/session. Charge
  trapped on the K3/C19/C21 coupling node MUST be discharged before K3 recloses; the hardware bleed
  and firmware unmute delay MUST be sized and verified together. Reset/brownout behavior during the
  discharge interval MUST be included in the transition analysis.
- **RING-5 (SHOULD)** Detection SHOULD be galvanically isolated from the bus (see SAFE-3).

## GONG — Audible gong suppression

- **GONG-1 (MUST)** Be able to suppress the audible mechanical gong for **front-door (Türruf)** calls
  on command from the firmware, without losing detection (RING-3).
- **GONG-2 (SHOULD)** Suppression SHOULD be software-controllable (per-call / on-off). It applies to
  the **front-door (Türruf) gong only**; the apartment-door (Etagenruf) gong is **never suppressed**
  (GONG-4), and front-door suppression MUST leave Etagenruf unaffected.
- **GONG-3 (MUST)** Default and unpowered state is **gong rings** (fail-safe): the suppression
  element passes line 4 when de-energised.
- **GONG-4 (MUST)** The **apartment-door (Etagenruf) gong MUST remain audible in every state** —
  powered, idle, while the front-door gong is being suppressed, booting, unpowered, or with
  crashed/absent firmware — and the board MUST NOT be able to silence it. Suppression is **front-door
  (Türruf) only**, and the Etagenruf's audible path MUST be **independent of the suppression element**,
  so that "always audible" is a *hardware* property, not a firmware policy (no bug, misconfig, stuck
  relay, or held mute can defeat it). Rationale: the Etagenruf is the bell at the apartment's own door
  — someone is physically present — a higher-criticality alert than the building-entrance Türruf, so
  it must never be silently dropped. (Etagenruf *detection* / notification MAY still be added;
  detection never gates the acoustic path.)

## AUDIO — Two-way speech

- **AUDIO-1 (MUST)** Receive (listen to) audio from the bus speech pair (down-audio, line 2) into the
  ESP/codec.
- **AUDIO-2 (MUST)** Inject **ESP/codec-generated** audio onto the bus speech pair (up-audio, line 3)
  — the firmware streams audio to the bus. **Minimum:** play a custom welcome chime on a ring (e.g.
  before auto-opening). **Goal:** arbitrary streamed audio (announcements / TTS, and live talk).
  Field operation proves that injected line-3 audio reaches the door station with the 2.2 kΩ
  handshake; the current design retains that topology and isolates raw P4 before early TX.
- **AUDIO-3 (MUST/MAY)** Half-duplex is **sufficient** and is the baseline (a talk window opened
  after a ring; single transducer, so no echo cancellation). Full-duplex is a **MAY** (nice-to-have)
  and is **contingent on the TV20/S supporting it at all** — likely it does not; it needs a bench
  test of the TV20/S before it could be committed (see Open questions / full-duplex feasibility).
- **AUDIO-4 (MUST)** The bus audio tap MUST NOT DC-load the bus: **AC-coupled** (a series DC-block, so
  no DC flows) and presenting a **high AC impedance** so it does not appreciably attenuate other
  handsets on the shared speech pair (the speech-pair case of BUS-1). *(Met by series DC-block caps +
  the differential high-Z RX tap; the original isolation-transformer coupling was dropped — see AUDIO-5.)*
- **AUDIO-5 (SHOULD)** The audio path SHOULD be galvanically isolated from the bus (see SAFE-3).
  **Deviation:** the design drops the isolation transformer for an active, AC-coupled front-end with
  **P1 bonded to board GND** — a measurement-justified SHOULD deviation (P1 ≈ earth), so SAFE-3 is
  *not met* and containment falls to SAFE-7.
- **AUDIO-6 (SHOULD)** RX and TX SHOULD carry intelligible voice-band speech at a usable level — a
  clean half-duplex turnaround, no speech-masking pops — not merely "a signal is present".
- **AUDIO-7 (MAY)** Privacy (optional, **firmware-gated**): the firmware MAY restrict bus-audio
  capture to active sessions / explicit user action and auto-time-out talk, so the board is not a
  silently-always-on mic on the shared bus. Not a hardware requirement.
- **AUDIO-8 (MUST)** The RX tap MUST present the bus to the codec mic input within the ES8311's input
  abs-max under the worst-case **normal** bus level — the line-2 Türruf gong (bench-measured ±8.8 V),
  not only under fault transients (which are SAFE-1) — **including with the board unpowered** (the
  permanently-wired tap sees every bus event in passive-fallback mode, when the abs-max window
  collapses to ±0.3 V). *(Met by the 22 kΩ/3.3 kΩ series+shunt divider, ~−18 dB, biasing MIC1P/N to
  VMID; D14/D17 clamp MIC1P to AVDD/GND through separate low-VF Schottkys. D18 blocks reverse
  current into the analog LDO and R37 sinks the unpowered AVDD rail — see DESIGN "Audio path".)*
- **AUDIO-9 (MUST)** The TX inject path MUST keep the codec **output** (OUTP) within the ES8311's
  output abs-max — both under **normal** bus transients stepping C14's bus side (TX_OUT — chiefly a
  door bridge pulling line 3 to the rail while PTT holds the output gate closed) and under a
  **single-fault C14-short** (sustained bus DC through R26). The
  TX counterpart to AUDIO-8. *(Met by R26 (2.2 kΩ) limiting current into the D13/D16 low-VF
  Schottky clamps to AVDD/GND, with D18/R37 containing positive injection on AVDD — see DESIGN
  "Audio path" / TX front-end.)*
- **AUDIO-10 (SHOULD)** Outbound TX (greetings, talk) SHOULD NOT re-inject the bus's own gong onto the
  talk line: the Türruf tone standing on line 2 during a latched session (or a neighbour's ring on the
  shared line 2) must not ride the talk handshake onto line 3 at an audible level, and the greeting
  should not need to be delayed to avoid it. *(Met on V4.2 by opening K6 after K5 pull-in, separating
  raw P4 from the latched P2 handshake source. The deployed V4.1 board meets the audibility half with
  a firmware gong-wait, at the cost of the no-delay half.)*

## DOOR — Door opener

- **DOOR-1 (MUST)** Trigger the door opener under firmware control, **behaviourally equivalent to
  pressing the handset's own door button (S1)** — which means the button's *whole* effect, not just
  the line-2↔line-3 bridge the TV20/S reads as "open" (see DOOR-4 and MODE-3).
- **DOOR-2 (SHOULD)** The trigger SHOULD coexist with an in-progress ring (e.g. wait out / not be
  defeated by the gong), per the TV20/S timing in DESIGN.md.
- **DOOR-3 (MUST)** No single fault may open the door: a booting, unpowered, or floating board MUST
  NOT actuate the opener (relays default off, SAFE-6), and a welded audio/PTT relay MUST NOT be able
  to fire it (the opener takes a deliberate, separate closure that idle/talk states never assert).
- **DOOR-4 (MUST)** A firmware door-open MUST **end the session exactly as the handset button does** —
  release the passive WF26 latch (K5). The handset's S1 is a **break-before-make DPDT transfer**:
  it lifts line 2 off the latch's seal-in node (K1_COM) *before* it bridges line 2↔line 3, so the latch
  drops and the call ends as the door fires. The board's door actuator MUST reproduce that transfer — it
  MUST NOT stand in as a bare parallel line-2↔line-3 short. A bare short fires the opener but leaves the
  latch **sealed in**, with two wrong consequences: **(a)** the session **lingers** until the ~60 s
  timeout, so the board still reads "session active" (line 4 hot, OC1 high) after the door is already
  open; and **(b)** the held latch **bridges the live line 4 onto line 3** (P4→K1_COM→line 2→line 3).
  Mirroring S1's transfer removes both. *(Met: **K4** — an NC SSR in series in the seal-in — drops the
  latch on a door-open, and **Q3** (an AO3400A logic-level N-FET) **+ R17·C18 RC** delays K2's make
  ~38 ms behind K4's break for a hardware break-before-make; see DESIGN.md "Door-open mirrors S1".
  Verified in `sim/test`.)*
- **DOOR-5 (SHOULD)** A board door-open SHOULD **self-terminate in bounded time even if the firmware
  hangs** with the drive asserted: a stuck-high door line MUST NOT hold the opener indefinitely (the
  TV20/S is passive — it does not time-limit the bridge). *(Met: a hardware **max-on-time watchdog** —
  an RC one-shot, R25 (10 MΩ) · C20 (2.2 µF) (τ ≈ 22 s), whose FET (**Q4**) gates the K2 drive off
  ~8.4 s typ after assertion (fast corner ~3.1 s, clear of the 1.75 s pulse — DOOR-6) regardless of the GPIO, releasing the P2↔P3 bridge; D11 re-arms it when the
  line drops. Reset/brownout already drops the opener via the gate pull-downs (DOOR-3 / SAFE-6), and the
  ESPHome task watchdog reboots a hang — so this is defense-in-depth. See DESIGN.md "Door-open
  max-on-time watchdog". Verified in `sim/test`.)*
- **DOOR-6 (MUST)** The DOOR-5 watchdog window MUST be **corner-validated**, not nominal-only: across
  the AO3400A Vgs(th) (0.65–1.45 V) × R/C tolerance × MLCC bias/temperature derating, its release time MUST
  stay **above the firmware door pulse + margin** at the fast corner (so a legitimate open is never
  truncated) and **below a stated upper bound** at the slow corner (so a hung drive is bounded).
  *(Met by R25 (10 MΩ) · C20 (2.2 µF): fast corner ~3.1 s > the 1.75 s pulse; ~8.4 s typ; ~18 s slow
  corner — and the logic-level Vgs(th) keeps the watchdog provable even at the worst-case VOH/leakage
  plateau — see DESIGN.md "Door-open max-on-time watchdog".)*

## FW — Firmware host & control

This is a hardware spec; the smart behaviour is the firmware's job. So rather than enumerate
integration/security/networking requirements, we require the board to *host* the firmware that
provides them.

- **FW-1 (MUST)** Host and run the project's **ESPHome firmware**: an ESPHome-supported ESP32 with the
  peripherals the firmware drives — relay gate-drives (door / gong / PTT), the opto sense inputs, an
  I²S audio codec, I²C, and native USB. All *software* behaviour is **delegated to that firmware**, not
  to fixed hardware: Home-Assistant event reporting (rings front/apartment, session, door) and command
  handling (open door, gong suppress, talk/chime), access control + encryption, and network
  (re)connection. The smart layer is purely **additive** — with no firmware, no network, or no power
  the manual/passive intercom (MODE-1) still works, and the door opener is asserted **only by an
  explicit firmware command**, never autonomously on the board.
- **FW-2 (MUST)** Provide a programming/recovery interface: native USB for flashing + logs, and
  BOOT/EN for recovery if an OTA update fails (OTA itself is firmware; this is the hardware hook).
- **FW-3 (MUST)** Drive every SSR/opto input LED at its operate current. Per-pin GPIO source is
  ≤~18 mA (PTT_DRV/IO9 drives both K1 LEDs; DOOR_DRV/IO10 drives the K2 + K4 LEDs) and the simultaneous
  aggregate is ~37 mA — both within the ESP32-S3 per-pad (40 mA) and total-I/O budget. The firmware
  MUST keep the LED-driver pads **IO9 / IO10 at the ≥20 mA pad drive strength** (the ESPHome default),
  never the 5/10 mA settings, which would droop VOH and starve the LEDs; with the 220 Ω series Rs even
  the guaranteed-VOH corner holds every LED at ≥~5.6 mA (≥ the SUPSiC 5 mA recommended floor, ~2.8× the
  ~2 mA must-operate; ~8–9 mA typ dual-load). *(Met by the default — a don't-reduce
  constraint; 40 mA is optional margin. See DESIGN.md "Switches K1–K4".)*

## SAFE — Safety & robustness

- **SAFE-1 (MUST)** Tolerate bus over-voltage and transients (surge / ESD on the exposed bus
  terminals) without damage.
- **SAFE-2 (MUST)** **Survive** reverse polarity and any incorrect bus-line ordering at J2 (and reverse
  polarity on the local-power input) **without damage**. The board **need not function** while the bus is
  miswired, but reversed/scrambled bus wiring MUST NOT damage it, and it MUST recover once wired correctly.
  (A bidirectional AC+DC bus rules out series blocking — see DESIGN "SAFE-7 bus protection".)
- **SAFE-3 (SHOULD)** Galvanically isolate the smart layer (ESP/codec/GND) from the TV20/S bus. The
  current design **does *not* meet this** — a deliberate, measurement-justified deviation: the
  transformer-less audio bonds **P1 to board GND** (the bench measured P1 ~0.5 V from earth, so it's
  benign — assuming a floating-output Class II USB supply; an earthed feed re-references P1 to earth,
  see DESIGN "Bus↔logic coupling"). The sense optos and the SSRs still give LED barriers on the detection and actuator paths,
  but the codec RX/TX taps and the P1↔GND bond couple the bus to logic ground. Bus-side fault
  containment therefore rests on **SAFE-7** (per-tap protection + the sacrificial board behind F1),
  not a galvanic barrier.
- **SAFE-4 (MUST)** **Fail-safe / fail-passive**: with no board power, the board degrades to a working
  passive handset (MODE-1) — the on-board WF26 core runs bus-powered while the SSRs/optos/codec go inert.
- **SAFE-5 (MUST)** The smart layer is powered locally (5 V through J1), not from the bus; absence of
  that feed MUST degrade gracefully to the passive behaviour of SAFE-4.
- **SAFE-6 (MUST)** All actuators default to their inactive/safe state at power-on and while the MCU
  is unprogrammed/booting/floating: relays off (gate pull-downs) so the door opener cannot pulse and
  the gong cannot be silenced by a booting or dead board.
- **SAFE-7 (MUST)** **Fault containment — the board is sacrificial.** Under a fault beyond the
  SAFE-1/SAFE-2 envelope (severe bus surge, mis-wire, internal short, ESD), the board itself **may be
  destroyed**, but the damage MUST stay contained:
  - **upstream** — it must not damage the **USB power supply**: F1 fuses the board off VBUS before a
    clamp or short can back-feed the supply, so the board fails open to USB;
  - **downstream** — it must not damage the **TV20/S bus or the rest of the apartment**: the board
    must never put damaging voltage/energy onto the bus; with no galvanic barrier (SAFE-3 not met),
    bus-side faults are contained by **per-tap protection** (series R + clamps + DC-block caps) and
    the board's own destruction.
  Net: everything the board connects to survives; only the (replaceable) board is lost.

## MECH — Mechanical (enclosure fit)

- **MECH-1 (MUST)** The board MUST physically fit the **original WF26 enclosure** — outline, mounting
  holes, and the speaker / button / wire-entry positions are set by the housing. (Dimensions and the
  pinned positions are in DESIGN.md "Enclosure reuse".)
- **MECH-1a (MUST)** The enclosure's existing **buttons must still fit and must actuate the board's
  switches**: the switch plunger tips (door, talk) land under the housing's button apertures so a
  physical press operates them — this is also what makes the manual buttons work unpowered (MODE-1a).

**MECH-1 / MECH-1a verification status:** PASS on the assembled V4.1 PCB in the real WF26 housing.
The board seats on the bosses, the lid closes over the populated board, the transducer and wire
entry align, and both housing buttons actuate their board switches. This physical installation is
the authoritative enclosure-fit check; re-open the gate if the mechanical interface or component
height envelope changes.

## VER — Verification

- **VER-1 (MUST)** The design MUST be validated with **unit / integration tests in the project's
  circuit simulator** (`sim/`), exercising **both** the **original WF26 handset** (the reference
  behaviour the board must match) and the **board**, with the board in both **powered** (smart layer
  active) and **unpowered** (passive fallback) states. The tests MUST show the unpowered board
  reproduces the WF26's behaviour (MODE-1, SAFE-4) and the powered board adds the smart functions
  without violating BUS-1 or BUS-2 (composed-state cross-coupling — e.g. the `K6 isolation` test).
  (Test *results* live in DESIGN.md "Verification status"; the verification *procedure* — what to
  run and check — is VERIFICATION.md.)

---

*Resolved:* Galvanic isolation — **SHOULD**, not MUST; the hard requirement is fault containment
(SAFE-7) — the board may fry, but the USB supply and the apartment must not. Etagenruf — MUST stay
audible in all states and is structurally never suppressible (GONG-4); only the Türruf is suppressed.
Half-duplex — sufficient (AUDIO-3). Replacement-only — the board is the single endpoint on its
private line 4, carrying its own passive WF26 core (Context / MODE-2).

## Status

Requirement *verification* — the **simulator test suite** (VER-1, `sim/test/`), the ERC/DRC/route
gates, bench tests against the real TV20/S, and the open analog/TX-out items — is tracked in
**DESIGN.md "Verification status"** (the results); **VERIFICATION.md** is the *procedure* (what to
run and check). Results are not duplicated here.
