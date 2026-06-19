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

**Deployment scope:** line 4 (front-door / Türruf) is a **private, two-station line** — at most this
board plus **one** real WF26 (replacement = board alone; parallel = board + one WF26; never more).
The speech pair (lines 1/2/3) is a shared party line across apartments.

| Term | Meaning | Bus line |
|------|---------|----------|
| **Front-door call** | *Türruf* — the building/house door (Haustür); ~12 V DC gong pulse | Line 4 (IN-P4 incoming) |
| **Apartment-door call** | *Etagenruf* — the apartment's own floor/landing door | Line 5 (across 5↔1) |
| **Speech pair** | half-duplex audio: listen = line 2, talk = line 3, ref = line 1 | Lines 1/2/3 |
| **Replacement mode** | board is the only station at the tap; on-board passive WF26 core live (J3/J4 closed) | — |
| **Parallel mode** | board taps the bus alongside an external WF26; on-board core isolated (J3/J4 open) | — |

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
- **MODE-2 (MUST)** With **J3/J4 open**, operate in **parallel** alongside an existing, unmodified
  WF26, tapping the same bus terminals.
- **MODE-3 (MUST)** In parallel mode (the only other station being **one** real WF26) the board MUST
  NOT double the load the apartment presents to the bus — no second transducer/coil/C1 across the
  lines — nor otherwise disturb that WF26 or the shared speech pair. The on-board passive core is
  isolated by J3/J4 (only line 1 stays connected, as reference), and the audio tap stays high-Z
  (see AUDIO-4).
- **MODE-4 (MUST)** The two modes are **mutually exclusive** — never run the on-board core and an
  external WF26 together.

## BUS — bus loading & compatibility

- **BUS-1 (MUST)** On **every** bus line, the board MUST NOT draw more current — or present a heavier
  load — than a stock WF26 does; ideally (SHOULD) it presents the *same* load the WF26 does. The
  passive core matches by construction; the smart additions are the only things beyond it, and each
  MUST stay negligible against the stock load:
  - **sense optos** tap high-Z and only on an active line (~2 mA off a ringing line, far below the
    WF26's own ~37 mA Türruf-relay coil);
  - the **audio tap** is transformer-coupled, DC-blocked and high-Z (AUDIO-4) — no DC load, negligible
    AC load across the speech pair;
  - **relays** default open (SAFE-6) — nothing added at rest.

  MODE-3 is this rule applied to parallel mode (don't double the apartment's load).

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
  (Whether the injected audio reaches the door station is the TX-out-reach open item.)
- **AUDIO-3 (MUST/MAY)** Half-duplex is **sufficient** and is the baseline (a talk window opened
  after a ring; single transducer, so no echo cancellation). Full-duplex is a **MAY** (nice-to-have)
  and is **contingent on the TV20/S supporting it at all** — likely it does not; it needs a bench
  test of the TV20/S before it could be committed (see Open questions / TX-out reach).
- **AUDIO-4 (MUST)** The bus audio tap MUST be transformer-coupled and MUST NOT DC-load or saturate
  the bus: a series DC-block in the bus winding so no DC flows through it, and the tap presents a
  high AC impedance so it does not appreciably attenuate other stations (the speech-pair case of
  BUS-1; supports MODE-3).
- **AUDIO-5 (SHOULD)** The audio path SHOULD be galvanically isolated from the ESP/codec (see
  SAFE-3) — the isolation transformer serves both AUDIO-4 and SAFE-3.
- **AUDIO-6 (SHOULD)** RX and TX SHOULD carry intelligible voice-band speech at a usable level — a
  clean half-duplex turnaround, no speech-masking pops — not merely "a signal is present".
- **AUDIO-7 (MAY)** Privacy (optional, **firmware-gated**): the firmware MAY restrict bus-audio
  capture to active sessions / explicit user action and auto-time-out talk, so the board is not a
  silently-always-on mic on the shared bus. Not a hardware requirement.

## DOOR — Door opener

- **DOOR-1 (MUST)** Trigger the door opener under firmware control, electrically equivalent to a
  handset door-button press (the line-2↔line-3 bridge the TV20/S reads as "open").
- **DOOR-2 (SHOULD)** The trigger SHOULD coexist with an in-progress ring (e.g. wait out / not be
  defeated by the gong), per the TV20/S timing in DESIGN.md.
- **DOOR-3 (MUST)** No single fault may open the door: a booting, unpowered, or floating board MUST
  NOT actuate the opener (relays default off, SAFE-6), and a welded audio/PTT relay MUST NOT be able
  to fire it (the opener takes a deliberate, separate closure that idle/talk states never assert).

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

## SAFE — Safety & robustness

- **SAFE-1 (MUST)** Tolerate bus over-voltage and transients (surge / ESD on the exposed bus
  terminals) without damage.
- **SAFE-2 (MUST)** Be reverse-polarity protected on the bus and local-power inputs.
- **SAFE-3 (SHOULD)** Galvanically isolate the smart layer (ESP/codec/GND) from the TV20/S bus — the
  primary means of SAFE-7's bus-side containment. The current design **meets this**: the only
  bus↔logic crossings are *through* the sense optocouplers, the relay coil↔contact air gaps, and the
  audio transformer (2000 VRMS), and **P1 is the bus common, not board GND**. The barrier SHOULD be
  preserved in layout (no plane bridges the two domains).
- **SAFE-4 (MUST)** **Fail-safe / fail-passive**: with no board power, replacement mode degrades to
  a working passive handset (MODE-1) and parallel mode leaves the external WF26 undisturbed.
- **SAFE-5 (MUST)** The smart layer is powered locally (USB-C / 5 V), not from the bus; absence of
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
    must never put damaging voltage/energy onto the bus, and bus-side faults stay behind the
    opto / relay-gap / transformer barrier (SAFE-3).
  Net: everything the board connects to survives; only the (replaceable) board is lost.

## MECH — Mechanical (enclosure fit)

- **MECH-1 (MUST)** The board MUST physically fit the **original WF26 enclosure** — outline, mounting
  holes, and the speaker / button / wire-entry positions are set by the housing. (Dimensions and the
  pinned positions are in DESIGN.md "Enclosure reuse".)
- **MECH-1a (MUST)** The enclosure's existing **buttons must still fit and must actuate the board's
  switches**: the switch plunger tips (door, talk) land under the housing's button apertures so a
  physical press operates them — this is also what makes the manual buttons work unpowered (MODE-1a).

## VER — Verification

- **VER-1 (MUST)** The design MUST be validated with **unit / integration tests in the project's
  circuit simulator** (`sim/`), exercising **both** the **original WF26 station** (the reference
  behaviour the board must match) and the **board**, with the board in both **powered** (smart layer
  active) and **unpowered** (passive fallback) states. The tests MUST show the unpowered board
  reproduces the WF26's behaviour (MODE-1, SAFE-4) and the powered board adds the smart functions
  without violating BUS-1. (Test *results* live in DESIGN.md "Verification status" / VERIFICATION.md.)

---

## Open questions (to nail down)

1. **TX-out reach & full-duplex feasibility (open, bench)** — does the TV20/S forward the board's
   line-3 talk audio to the door station once it sees the R16 handshake bridge (AUDIO-2), and does it
   tolerate simultaneous RX+TX at all (the prerequisite for the AUDIO-3 full-duplex MAY)? Both need a
   bench test against the real TV20/S; see DESIGN.md "Audio path".

*Resolved:* Galvanic isolation — **SHOULD**, not MUST; the hard requirement is fault containment
(SAFE-7) — the board may fry, but the USB supply and the apartment must not. Etagenruf — MUST stay
audible in all states and is structurally never suppressible (GONG-4); only the Türruf is suppressed.
Half-duplex — sufficient (AUDIO-3). Station count — at most board + one WF26 on a private line 4
(Context / MODE-3).

## Status

Requirement *verification* — the **simulator test suite** (VER-1, `sim/test/`), the ERC/DRC/route
gates, bench tests against the real TV20/S, and the open analog/TX-out items — is tracked in
**DESIGN.md "Verification status"** and **VERIFICATION.md**; results are not duplicated here.
