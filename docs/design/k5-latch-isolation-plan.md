# K5 latch and P4 isolation plan

Status: hardware and simulation implemented. The handshake/codec topology, K5/P4 isolation,
GPIO connections, recovery jumper and PCB routing are complete. Production firmware is intentionally
unchanged until a fabricated board passes passive bring-up; first-board validation remains.

## Current status

Completed in `kicad/doorbell.kicad_sch`:

- Implemented `OUTP → R26 → C14 → TALK_BRIDGE → R28 → TX_OUT`.
- Connected the two K1 contacts around the 2.2 kΩ handshake path.
- Defined R28 as 2.2 kΩ, `PCM_JLCPCB:R_0603`, LCSC `C4190`, MPN `0603WAF2201T5E`.
- Updated the TALK annotation and the C14, R28 and R29 descriptions.
- Split raw `P4` from `K5_LATCH` and inserted K6 as the normally-closed bridge.
- Connected K5's auxiliary NO contact as the direct K6 hardware interlock and `K5_SENSE` source.
- Added R34, R35 and R12 for K6 LED drive, sense pull-up and request pull-down respectively.
- Connected GPIO48 (U1 pin 25) to `ISO_REQ` and GPIO4 (U1 pin 4) to `K5_SENSE`.
- Added normally-open JP3 directly across K6's P4-to-`K5_LATCH` output as a recovery bypass.
- Synchronized, placed and routed K6, JP3, R12, R28, R34 and R35 on the PCB; connectivity reports no
  unrouted connections.
- Updated K5 and R35 descriptions for the auxiliary-contact circuit and corrected R12/R35 to the
  0402 `C25744` part metadata.
- Added integration coverage for K6 fail-safe continuity, the K5 hardware interlock, seal-in,
  release, gong isolation, JP3 and the R28/C14/K1 TX path.

Still pending:

- Validate the passive and isolation behavior on the first fabricated board.
- Implement and validate the firmware state machine only after that hardware check passes.

## Objective

Prevent this apartment's P4 gong from feeding through the latched K5 contact onto common P2 and then
through the smart 2.2 kΩ talk handshake onto P3. Preserve the stock WF26 behaviour whenever the board
is unpowered or the isolation feature is inactive.

This change addresses the P4 bleed mechanism. Improving the generally quiet codec TX level remains a
separate task.

## 1. Split raw P4 from the internal latch node

The implementation uses two nets:

```text
P4          Raw external TV20/S line
K5_LATCH    Internal handset latch and manual-Talk source
```

These connections are on `K5_LATCH`:

- K5 coil pin 1
- K5 primary NO contact pin 4
- D1 coil-flyback cathode
- R29 manual-Talk source

These connections remain on raw `P4`:

- J2 pin 4
- P4 TVS protection
- K3 chime input
- OC1, if retained

K6, a normally-closed PhotoMOS, connects the two nets:

```text
P4 ── P4_ISO (NC) ── K5_LATCH
```

At rest and without board power, `P4_ISO` is closed so the passive handset remains stock. JP3 is a
normally-open solder-jumper bypass across the output contact. Bridging it permanently restores the
original P4 topology if the isolator fails open or isolation must be disabled.

## 2. Use K5's spare pole as a direct hardware interlock

K5 is an Omron G6K-2F-Y DPDT relay. Its formerly unused second pole now reports the actual armature
state while also completing the K6 LED circuit:

```text
K5 pin 6, auxiliary COM ── GND
K5 pin 5, auxiliary NO  ── K5_SENSE
K5 pin 7, auxiliary NC  ── unconnected

K5_SENSE ── 10 kΩ ── +3V3
K5_SENSE ── U1 pin 4 / GPIO4 input (active low)

U1 pin 25 / GPIO48 output (ISO_REQ) ── 220 Ω ── K6 LED anode
K6 LED cathode ── K5_SENSE
ISO_REQ ── 10 kΩ ── GND
```

GPIO4 and GPIO48 are suitable for this module and placement:

- Neither is an ESP32-S3 strapping pin; GPIO0, GPIO3, GPIO45 and GPIO46 are avoided.
- Both are ordinary 3.3 V input/output pins on the fitted `ESP32-S3-WROOM-1U-N16R8`.
- GPIO4 is a free general-purpose input close to the K5/K6 routing corridor; GPIO48 is a free
  general-purpose output suitable for the isolation request.
- GPIO35–37 are not alternatives on the N16R8 because its Octal PSRAM uses them.
- R12 holds GPIO48/`ISO_REQ` low while the pin is high-impedance at reset, and R35 holds
  GPIO4/`K5_SENSE` high until K5 physically closes its auxiliary contact.

The effective hardware logic is:

```text
P4_ISO_OPEN = ISO_REQ high AND K5 auxiliary contact closed
```

This direct-contact arrangement provides the hardware interlock without MOSFETs or delay logic:

- `P4_ISO` cannot open before K5 has physically pulled in, even if the isolation request is stuck on.
- If K5 starts to release, its auxiliary contact directly interrupts K6 LED current and the
  normally-closed P4 path restores independently of firmware.
- The isolation-control GPIO must have a pull-down so reset and boot request the closed state.
- The K6 LED load is approximately 9.5 mA, matching the board's existing direct GPIO-driven PhotoMOS
  channels.

Apply approximately 5–10 ms of firmware debounce to `K5_SENSE` before raising `ISO_REQ`. The hardware
interlock proves armature position, not electrical continuity of K5's primary seal-in pole. Make the
first isolation attempt while the original P4 pulse is still present. If the primary pole fails to
hold and `K5_SENSE` returns high, the fast-closing isolator can reconnect the still-live P4 source;
firmware must then clear the request and abandon early TX rather than retrying.

## 3. Firmware state machine

This is a post-fabrication implementation plan. Production firmware remains on the proven
V4.1-compatible OC1 and 1.75 s gong-wait behavior until the first V4.2 board passes passive bring-up
and K6 validation.

| State            |         K5 |        P4_ISO |     K1 |
|------------------|-----------:|--------------:|-------:|
| Idle             |   released |        closed |   open |
| Ring acquisition | pulling in |        closed |   open |
| TX preparation   |    latched |          open |   open |
| Welcome/TX       |    latched |          open | closed |
| Gong tail        |    latched |          open |   open |
| Listen/RX        |    latched |        closed |   open |
| Session ended    |   released | forced closed |   open |

For a greeting following a ring:

1. Wait for `K5_SENSE` to remain asserted low for approximately 5–10 ms.
2. Request P4 isolation.
3. Wait for the PhotoMOS's specified maximum opening time.
4. Confirm that `K5_SENSE` remains asserted. If it returns high, close the isolator and abandon early
   TX.
5. Assert K1.
6. Apply a calibrated PTT pre-roll.
7. Start playback.
8. Release K1 when playback ends.
9. Keep P4 isolated until the measured gong window has ended.
10. Close P4 isolation and restore RX.

K3 gong muting is an independent policy. It may remain open or closed throughout this sequence: K3
only controls raw `P4 → CHIME_C1 → C19 → LS1`, whereas `P4_ISO` only separates raw P4 from
`K5_LATCH`. The P4-isolation safety argument must not rely on K3's state.

At any point, loss of `K5_SENSE` must stop playback, open K1 and clear the isolation request. The
hardware interlock independently restores the P4 path.

If the primary K5 seal-in contact does not conduct, K5 will drop immediately after isolation opens.
Treat this as a failed latch: fail closed and do not repeatedly retry or chatter the relay.

## 4. OC1 migration

For the first implementation, retain both signals:

```text
OC1         Raw external P4 activity and diagnostics
K5_SENSE    Authoritative ring/session state (active low)
```

This distinguishes `P4 present but K5 failed to pull in` from a successfully latched session. After
hardware validation, OC1 may be removed if its raw-P4 diagnostic coverage is not worth the parts and
GPIO. K5's auxiliary contact is the preferred functional session input because it reports the actual
handset state and naturally rejects pulses too short to operate K5.

## 5. Handshake and codec topology

The schematic and PCB use the field-proven topology:

- R28 is the single 2.2 kΩ talk-handshake resistor.
- C14's bus side connects to `TALK_BRIDGE`.
- R34 drives K6's LED, and R35 pulls up `K5_SENSE`.
- PCB routing is complete; final parity and fabrication checks remain.

The restored topology is:

```text
Handshake:  P2 → K1A → TALK_BRIDGE → R28 2.2 kΩ → TX_OUT → K1B → P3
Codec TX:   OUTP → R26 2.2 kΩ → C14 → TALK_BRIDGE → R28 → TX_OUT → K1B → P3
```

This preserves the field-proven handshake assertion, codec summing point and idle isolation. K6
prevents this apartment's gong from contaminating the P2 handshake source.

V4.1's codec TX is already somewhat quiet. Output-level improvement or a buffered TX driver remains
a separate issue and must not be mixed into the P4-isolation change.

Keep the restored component metadata synchronized with the PCB and fabrication outputs:

```text
R28 value:      2.2 kΩ
R28 footprint:  PCM_JLCPCB:R_0603
R28 LCSC:       C4190
R28 MPN:        0603WAF2201T5E
```

## 6. D1 and C19 protection

Splitting P4 moves D1's coil-flyback function onto `K5_LATCH`. While isolation is open, D1 no longer
clamps negative excursions on raw P4 coupled through the gong-capacitor network. Close the existing
D1/C19 qualification work as part of this change:

- Keep a correctly rated flyback diode directly across the K5 coil.
- Qualify or add separate protection for the raw P4/C19 path.
- Qualify the raw P4/C19 path with K3 both open and closed; P4 isolation must be safe in either
  chime state.
- Verify that reset and reconnection cannot expose C19 or LS1 to a harmful transient.

## 7. Relevant BOM

| Function                     | Qty | Part/value             | LCSC     | Notes |
|------------------------------|----:|------------------------|----------|-------|
| K6 P4 isolator               |   1 | GAQY412EH, NC PhotoMOS | C7435135 | Same part and footprint as K3 |
| K6 LED resistor              |   1 | 220 Ω, 0603            | C22962   | Approximately 9.5 mA from GPIO |
| `K5_SENSE` pull-up           |   1 | 10 kΩ, 0402            | C25744   | Defines released/high state |
| `ISO_REQ` pull-down          |   1 | 10 kΩ, 0402            | C25744   | Keeps K6 closed during boot/reset |
| Handshake resistor           |   1 | R28, 2.2 kΩ, 0603      | C4190    | Field-proven talk assertion |
| P4-isolator bypass (JP3)     |   1 | Open solder jumper     | No BOM   | Field recovery if K6 fails open |

## 8. Simulation and structural coverage

Integration tests prove:

- An unpowered board leaves `P4_ISO` closed.
- Raw P4 initially energizes K5 normally.
- Isolation cannot open before the K5 auxiliary contact closes.
- K5 remains sealed from P2 after isolation.
- Raw P4 gong no longer reaches P2/P3 while isolated.
- The 2.2 kΩ handshake asserts talk promptly.
- K5 release forces the isolator closed.
- Reset during isolation restores the stock topology.
- Door-open and timeout still release K5.
- Manual Talk and Door retain their passive behaviour.
- The R28/C14/K1 topology matches the intended netlist.

The simulator's K5 model exposes both poles and makes them follow the same mechanical state.

## 9. PCB implementation

- K6 is placed at `(69.25, 39.75)`, with R34, R35 and R12 beside its LED/control side. JP3 is at
  `(63.925, 33.5)`, and R28 is beside K1/TX_OUT at `(70.5, 50.68)`. The placement-constraint check
  passes with all footprints inside the board outline.
- U1 pin 25 (GPIO48) is routed on `ISO_REQ`, and U1 pin 4 (GPIO4) is routed on `K5_SENSE`. The external
  default resistors provide a deterministic logic interface without consuming a strapping or PSRAM
  pin.
- JP3 is routed directly across K6's `P4` and `K5_LATCH` output nets and remains open by default.
- Keep raw `P4` and `K5_LATCH` visibly distinct in both schematic and PCB net names.
- Route the auxiliary contact only on the logic side; do not compromise the relay's galvanic
  isolation geometry.
- Do not add dedicated test-point footprints: J2 pin 4, K5 pins 1/4 and K5 pin 5 provide access to raw
  P4, `K5_LATCH` and `K5_SENSE`. Add small bare pads only if those pins prove inaccessible.
- Keep all assembled components on the top side. Use the empty bottom only for routing and vias, not
  double-sided assembly.
- Move or remove TP3 if its pad or silkscreen obstructs K6; its former test is no longer required.
- Resolve the known `kicad-cli pcb drc` crash on this board before relying on automated DRC results.
- Re-run ERC, DRC, schematic/PCB parity, simulation and the complete release build.

## 10. First-board validation

1. With board power removed, verify continuity from raw P4 to `K5_LATCH`.
2. Ring and measure the K5 auxiliary-contact operate timing.
3. Open isolation and confirm K5 remains engaged from P2.
4. Compare P2 gong amplitude before and after isolation.
5. Scope raw P4, P2 and P3 during immediate TX.
6. Confirm local gong behaviour with K3 both open and closed, then verify manual Talk and subsequent
   RX still work.
7. Reset and brown out the controller while isolation is open.
8. Verify session timeout and door-open release.
9. Simulate a failed seal-in by preventing K5 hold and confirm that isolation fails closed without
   repeated chatter.
10. Bridge the bypass jumper and confirm exact stock behaviour.

## Acceptance criteria

The design is acceptable when:

- K5 always establishes before raw P4 can be disconnected.
- Isolation removes the own-ring gong from P2/P3 by the required margin.
- K5 remains held throughout TX and releases normally on door-open and timeout.
- Any reset, loss of board power, invalid state or detected latch failure restores the P4 connection.
- The unpowered handset, manual Talk, manual Door and post-TX listen path match the stock WF26.
- Welcome audio reaches the door at a usable, unclipped level.
