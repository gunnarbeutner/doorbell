# Audio refactor — plan

**Status: planned, not yet built.** This is the decision record for a reworked analog audio path
(and the mode/connector changes it pulls in). It is *not* yet reflected in the KiCad files,
DESIGN.md, or REQUIREMENTS.md — those get one coherent pass once this is agreed. Cross-refs:
DESIGN.md "Audio path" / "Relays" / "Dual-mode variant"; REQUIREMENTS.md AUDIO/MODE/BUS/GONG/SAFE.

## Why

The current audio path (one SM-LP-5001 isolation transformer T1, its bus winding steered by K1's
pole B between line 2 RX and line 3 TX) has structural problems we confirmed:

- **T1 is DC-coupled across the bus** (no series cap): its ~115 Ω winding DCR sits across P1↔P2 at
  rest and conducts ~104 mA when line 2 goes DC-hot → core saturation + a DC load on the very node
  (P2) that self-holds the WF26 latch. Violates AUDIO-4 / BUS-1.
- **T1 kills the talk handshake:** during talk, R16 pulls line 3 toward the ~12 V held level, but
  T1's 115 Ω winding forms a 2.2 k/115 Ω divider → line 3 only reaches **~0.6 V** instead of DC-hot
  ~12 V (the failing `# TODO` integration test). The TV20/S likely never registers talk.
- **Dual-mode (J3/J4) is incompatible with chime-suppress** (see below).

Two empirical anchors from the bench (osci notes + `ring4`):

- The TV20/S speech path is **AC-coupled audio power amps (LM380N + TAA861A) + relay switching**, so
  the bus *audio* is AC-coupled at the TV20/S — the DC on the speech lines is a separate **signalling**
  layer (session / talk-detect / hold) handled by relays, not the amps.
- **Bus common (P1) sits ~0.5 V from apartment earth** (NTR201 secondary / TV20/S earth-references
  it), and the TV20/S tolerates P1 bonded to earth (scope test) → bonding P1↔GND is benign here.
- At a ring, the **gong tone lags the line-4 DC pedestal by ~13–16 ms** (pedestal 1 V→8 V over ~12 ms,
  tone onset ~3 ms after it tops out) → there is a real reactive window before the gong is audible.

## Decisions

### 1. Replacement-only — drop J3/J4
Chime-suppress works by breaking line 4; in parallel mode the board is in series with an external
WF26's line 4, so suppressing cuts that handset off the Türruf (no gong **and** no session). The two
are mutually exclusive, so parallel mode is dropped.
- **Keep the passive WF26 core, hardwired** (it's the unpowered fallback, MODE-1) — no isolation
  needed without an external unit. Remove the J3/J4 links; merge `/WF26_P4≡/P4`, `/WF26_P5≡/P5`.
- One configuration: the board *is* the handset.

### 2. K3: line-4 break → speaker mute (chime-suppress without killing the session)
Move K3 out of line 4. **K3 = NC relay in series with the transducer path**, energise to mute:
- Default / boot / unpowered = de-energised = connected = **gong rings** (fail-safe, GONG-3/SAFE-6).
- **Reactive** is sufficient — energise on the OC1 (Türruf) edge; the ~13–16 ms pedestal→tone gap
  covers a GPIO-step relay (~3 ms operate) or a PhotoMOS (the GAQY412EH candidate is ~0.5–2 ms, *not*
  µs — see Decision 7; both still fit the window). Pre-arm is the zero-leak fallback
  (but inverts boot-default and needs continuous energising — only if the bench leak is too big).
- **The constant Etagenruf tone on line 5 does *not* force a pre-arm.** P5 is a Dauerton with no
  pedestal→tone ramp, so it can't be reactively muted — but it's also *not a suppression target*, and
  the C1-cut topology deliberately routes it around K3 (direct on line 5, bypassing C1), so K3 can't
  touch it regardless of pre-arm vs reactive. The only thing K3 suppresses (Türruf, via C1) keeps its
  ramp window, so reactive stays correct. The constant tone would only matter *if* we wanted to
  suppress Etagenruf — a non-requirement that the C1-cut topology can't do anyway.
- **Reactive↔pre-arm must stay a no-respin firmware choice.** They are two GPIO drive patterns on
  the same circuit (pulse-on-edge vs hold-from-boot, drop-to-let-a-wanted-gong-ring). To keep pre-arm
  available purely in firmware *if reactive leak shows up on the bench*, two hardware properties must
  hold: (a) K3's coil is driven by a plain GPIO→driver that can **hold** it — no RC one-shot /
  monostable / auto-release between GPIO and coil (the relay-driver sheet is already this); and
  (b) the USB power budget has **continuous-duty headroom** for a held K3 coil (the only thing that
  would otherwise force a respin). Fail-safe is preserved either way: NC + GPIO driver de-energises on
  GPIO-low / power-loss / crash / watchdog → releases → rings.
- **Optional upgrade path (not decided):** a PhotoMOS on the C1 break would shrink the reactive leak
  (µs switching) *and* make a held-muted pre-arm near-zero-power, while its LED→MOSFET barrier keeps
  the GPIO isolated from the bus (a SAFE-7 plus, no contact arcing). It is electrically safe for this
  ~12 V-class node (pick ≥100 V Voff for transient margin; still wants the series-R + TVS clamp — C1
  DC-blocks, so the part mostly sees AC + transients). The catch is *part selection*, which must be
  **all four** at once: (a) **AC / bidirectional** (back-to-back MOSFETs — a DC part's body diode
  leaks one half-cycle and the mute fails); (b) **normally-closed / 1-Form-B** so LED-off = closed =
  ring keeps the fail-safe (the hard sourcing constraint — most parts are 1-Form-A); (c) **low Ron**
  (≤ ~2 Ω) since it sits in series with the 16 Ω speaker in the ring state and would otherwise divide
  down the gong; (d) **current-rated** above the gong's speaker drive (bench-measure — we only scoped
  bus voltages, estimate a few hundred mA peak). Mechanical relay is the default precisely because a
  common NC signal relay meets all four for free (bidirectional contacts, NC standard, mΩ resistance,
  amps of rating); the PhotoMOS is the fallback if the bench shows leak, trading sourcing for speed.
- **Hardware default stays NC = ring**, independent of the software policy (MODE-1 / GONG-3 / SAFE-6):
  de-energised K3 = connected = gong rings, so unpowered/boot still rings. A "default-silent, ESPHome
  gates every ring" posture is a *different product direction* (full audio mediation, custom chime
  instead of the gong) — it implies the **mute-LS1** topology + a **line-5 (Etagenruf) sense** +
  accepting a boot-window ring, and either inverts the fail-safe or needs a held coil that only stays
  crash-safe (releases-to-ring) when non-latching. Not adopted; reactive + NC-default is the baseline.
- **Selectivity — prefer K3 in series with C1, not LS1.** LS1 is the shared transducer: the Türruf
  gong reaches it via C1, but the Etagenruf reaches it **directly on line 5**. Cutting **C1**
  (P4↔P5) mutes the Türruf gong (and listen/talk, which are later — fine) while leaving Etagenruf
  untouched, and C1 isn't in the latch path so the session survives. (Muting LS1 instead also works
  *given* the Etagenruf is a constant Dauerton — its unmute latency is inaudible — but C1 is the
  surgical, no-classification choice.)
  - **Bonus: C1 placement also keeps the loud Etagenruf out of K3's current budget.** LS1 sits
    directly across P1↔P5, so the Etagenruf drives the speaker directly; K3-in-C1's only route to it
    is the *parallel* `P5 → C1 → P4 → coil → P1` branch, which the relay coil's ~320 Ω DCR chokes to
    ≈ 5 % of the speaker current (worst case ≈ 12 V / 320 Ω ≈ 37 mA, even for a much louder ring). So
    K3 sizes off the **Türruf alone** (~80 mA) regardless of how loud the Etagenruf is, and P5 never
    needs scoping. **The LS1-mute alternative loses this**: K3 would carry the full (louder)
    Etagenruf and would have to be sized for it (capture P5 first) — another point for C1.
  - **Safety invariant (the real reason to prefer C1): the Etagenruf is *structurally*
    non-suppressible.** Criticality is asymmetric — the Türruf is the building front door (low
    stakes; night/DND/auto-open suppression is a convenience), but the Etagenruf is the bell at the
    apartment's *own* door (someone is physically there — must never be silently swallowed). Because
    its path (`P5 → LS1 → P1`) bypasses K3, it stays audible in every state: unpowered, booting,
    idle, **actively suppressing the Türruf**, and even firmware-crashed-while-muted. The guarantee
    is hardware, not firmware — no bug, misconfig, stuck relay, or held mute can silence it (only a
    dead speaker/bus, same as the stock WF26). LS1-mute would have demoted this to a firmware
    promise. Note: always-audible ≠ ESP-unaware — an *additive* line-5 sense (for HA notify/log) is
    compatible, since detection never gates the acoustic path.

### 3. 5-way connector
With K3 off line 4, the IN_P4/P4 series split has no purpose → merge into one line-4 net → drop from
6-way to the WF26's native **5-way (P1–P5)**. This also removes the long-standing IN_P4-vs-P4
handshake-source ambiguity (one line-4 node).

### 4. Transformer-less audio — remove T1
Since the TV20/S is AC-coupled and P1↔GND can be bonded (justified by the 0.5 V measurement), replace
T1 with active, AC-coupled front-ends. **This requires the hard P1↔GND bond** (TX must drive line 3
relative to P1, which needs a low-Z return to P1 — no high-Z trick for an output). Trade: **SAFE-3
isolation drops from met → not met** (a deliberate, measurement-justified SHOULD deviation);
**SAFE-7 containment** now rests on per-tap protection (series R + clamp + DC-block cap + sacrificial
board, F1 on the USB feed). Removing T1 also **fixes the talk handshake** (line 3 free to go DC-hot
~12 V) and ends the core-saturation / bus-DC-loading problem.

- **RX (listen, line 2):** high-Z voltage sense — no bus loading (BUS-1). Preferred: **differential**
  across P2↔P1 (rejects hum / the 0.5 V common-mode, keeps a *soft* ~1 MΩ P1→GND tie instead of a
  hard bond). If the ES8311 ADC input is differential, feed P2/P1 in directly (AC-coupled + biased to
  MICBIAS) — no external in-amp. Single-ended cap+JFET also works but needs the hard bond and gives
  no CMRR.
- **TX (talk/chime, line 3):** mirror the WF26's own talk path with the codec as the mic —
  `codec DAC → buffer/atten → DC-block cap (the C1 analog) → R16 2.2 kΩ (the R1 analog) → K1 gate → P3`.
  - **R16 does double duty** (like the WF26's R1): asserting the bridge *is* the DC talk-handshake
    (held line → R16 → P3 goes DC-hot), and the same R passes the AC audio. No separate handshake.
  - **K1 gates it** (talk only) → high-Z at idle (BUS-1). Level set low (codec digital volume) to
    match the WF26's mic-through-2.2 kΩ drive, not overdrive the TV20/S amp.
  - DC-block cap sees the ~12 V line-3-during-talk offset → rate ≥25 V (50 V w/ margin); any clamp on
    that node must sit **above +12 V** or it kills the handshake.

### 5. Session / handshake mechanics (unchanged principle)
The talk DC on P3 originates at P2 and is routed by the **passive WF26 latch**:
`P2 → S1(NC) → WF26_K1_COM → WF26_K1 contact → line 4 → R16 → P3`. The latch (bus-energised, no GPIO)
is what self-holds the session; our K1+R16 only adds the last hop. So the board's session-dependent
functions require the passive core present and latched — which replacement-only guarantees.

**Consequence — TX is session-gated (deliberate, for now): `K1.4 → P4`.** Because the handshake DC
comes from P4, the board can only assert talk while the latch holds a Türruf session (P4 hot). That's
faithful to the WF26 and covers the welcome-chime-before-auto-open case (the ring *is* the session),
but it blocks autonomous announcements with no incoming call. Session-independent TX would instead
source from the always-on **P2** (`K1.4 → P2`, a strict superset — identical during a session, still
hot outside one), but only if the TV20/S actually forwards line-3 audio with no session active.
**Kept on P4 pending that bench test** — tracked in TODO.md ("session-independent TX") and the
TX-out-reach open item.

### 6. Session-sense stays on OC1 — the latch has no spare contact
Front-door detection would *ideally* track the **latch state** rather than a bus voltage (a latched
contact → 3V3 + GPIO is neighbour-immune and isolated). **But WF26_K1 is a single-pole 1-Form-C
(HJR-4102-N)** — its one pole's NO is already in the latch path and its COM is K1_COM (in the bus, so
not isolatable), and the free NC pin is not an independent contact. An isolated latch-sense would need
a *second* pole, i.e. replacing WF26_K1 with a 2-pole relay — **not happening** (the stock latch
stays). So **detection stays on OC1** (line-4 opto + its 5.1 kΩ limiter + D8 clamp); the earlier
"spare-contact, drop OC1" idea is withdrawn. (Still **don't** sense WF26_K1_COM directly — at idle
it's tied to the shared P2 via S1 → neighbour false-triggers.)

### 6b. Add a flyback/TVS across the WF26_K1 coil (P4↔P1)
The stock WF26 leaves the latch coil unclamped because the **speaker sits across it** (coil P4↔P1 ∥
C1+LS1) and damps the de-energisation kick to <0.5 V (16 Ω discharge). **K3 in series with C1 breaks
that path when open** — so during suppress, at session-end (line 4 collapses → coil de-energises) the
kick is undamped and swings tens-to->100 V on the high-Z P4 nodes, over **K3's 60 V Voff** and onto
OC1 / the talk path. Add a **flyback diode or TVS across the coil (P4↔P1)** — something the stock
board never needed but ours does. Use a TVS or diode+Zener if the plain-diode release delay matters
for the latch.
**Gong-transparent:** with the diode anode→GND, cathode→P4, it stays reverse-biased through the whole
ring (the gong rides the +~9 V line-4 pedestal, so P4 ≈ 8–10 V, never near the −0.7 V conduction
point) and only fires on the negative de-energisation kick. Its reverse junction capacitance (~pF,
~40 MΩ at 1 kHz) is negligible against the P4 node — no attenuation, clipping, or loading of the gong,
pedestal, or talk handshake.

### 7. Switch technology — our three relays → mostly solid-state
The G6K relays were a conservative V3 choice; in the transformer-less / replacement-only world all
three of **our** ESP-driven relays switch only low-voltage (≤12 V) mA-class signals → PhotoMOS
territory. (The **passive WF26 latch stays electromechanical — not an SSR candidate**, and for
fundamental reasons, not just convenience: (1) it's a *bus-energised self-latch with no controller* —
coil pulled in by the line-4 Türruf DC, then sealed-in from P2 — so it must work with the board dead
[MODE-1/SAFE-4]; an SSR needs its LED driven by *something*, so going solid-state means designing a
bus-powered self-latching circuit [SCR/thyristor or a discrete PhotoMOS seal-in], not a drop-in swap;
(2) its single contact carries bidirectional **AC audio *and*** the DC seal-in at once [`P2 → S1 →
K1_COM → contact → P4 → C1 → LS1`] — trivial for a metal contact, awkward for solid-state [an SCR
rectifies the audio; a bidirectional self-latch is parts-heavy]; (3) nothing to gain — it already
matches the WF26's native bus load [BUS-1 by construction], actuates once per call [no wear/power
concern], and speed is irrelevant. The asymmetry: **ESP-driven switches → SSR; passive bus-latch →
relay.**) Going solid-state buys: no coil power/heat, no
acoustic click, no contact bounce/wear, µs switching, and an optical GPIO↔bus barrier (a SAFE-7
plus). It costs per-switch part care (AC-vs-DC, NO-vs-NC for fail-safe, Ron-vs-load, current rating)
and off-state leakage (µA — negligible here). Per relay:

- **K1 (talk gate: codec → DC-block → R16 2.2 kΩ → K1 → P3) — convert.** Idle wants **open** (high-Z,
  BUS-1) = common **1-Form-A** PhotoMOS; R16's 2.2 kΩ swamps Ron (~tens of Ω, negligible on the
  ~5 mA handshake); unpowered talk is covered by the passive core's S2/R1 so K1-open-when-dead is
  correct. Needs an **AC** part (bidirectional talk audio).
- **K2 (door opener, P2↔P3) — convert, and it's arguably *safer*.** Idle wants **open** (door must
  never open on boot/fault) = 1-Form-A, natural fail-safe; solid-state also removes the relay door
  hazards (coil glitch pulsing it, contact bounce double-firing). TV20/S door is almost certainly a
  **signalling** bridge (central unit drives the strike from its own supply — ring4's P3→9.12 V step
  looks like signalling), so mA-class — but confirm the current on the bench before sizing.
- **K3 (chime mute, in series with C1) — relay or NC-SSR, both viable.** K3 must be **normally-closed**
  (de-energised = ring, GONG-3/SAFE-6). Two options: a mechanical NC relay, or the **GAQY412EH** SSR
  (JLCPCB C7435135) — **NC confirmed** (from the part/block diagram; note the *datasheet text* never
  states NC and its timing diagram reads NO, so don't rely on the datasheet alone for the form).
  Datasheet review (docs/GAQY412E_EH_datasheet.pdf) clears it electrically:
  - **AC/bidirectional ✓** (pins 3&4 both Drain, "60 V AC-peak or DC").
  - **Current ✓** — C1 inrush within the **0.6 A / 100 ms peak** rating (~530 mA <1 ms fits); ~80 mA
    gong well under 0.5 A continuous; clean mute (1 µA leak, C_out 165 pF ≈ 965 kΩ at 1 kHz); 5 kV iso.
    Gong sizing from ring4 holds (~80 mA composite / ~68 mA fundamental / ~26 mA door-open).
  - **Ron not a concern ✓** — typ 1 Ω / max 3 Ω (rises with temp, ~4 Ω hot), in series with the 16 Ω
    speaker: `16/(16+Ron)` = −0.5 dB typ / −1.5 dB max / ~−1.9 dB hot — imperceptible on a gong (no
    A/B reference, loud signal). Distortion swamped by the 16 Ω (below the TV20/S amps); 19 mW at the
    gong; high-pass corner only nudges 452→381 Hz (benign). Ron is spec'd at the 5 mA min drive, so
    driving ~7 mA (or higher) lowers it.
  - **"7 mA" = recommended LED forward current** (range 5–30 mA), not the trigger (operate ≤3 mA).
    Drive ~7 mA (≈300 Ω from 3V3); pre-arm hold ≈ 8 mW.
  - **Speed is ~0.5–2 ms, NOT µs** (T_on typ 0.5 / max 1.5 ms; T_off typ 0.25 / max 2.0 ms) — same
    order as a relay (~3 ms). Both fit the 13–16 ms window, so **speed is *not* a reason to pick the
    SSR over the relay** (correcting the earlier "speed kills the leak" claim). The SSR's real pull
    for K3 is no coil power, near-free pre-arm hold, no bounce/wear, and isolation — not speed.
  - Datasheet recommends a clamp diode / CR snubber across the load for inductive spikes — corroborates
    Decision 6b (WF26_K1 coil flyback/TVS).

  **Net: relay and GAQY412EH NC-SSR are both viable for K3** (NC confirmed, Ron/current/AC all OK).
  The choice is *not* about speed (a wash, ~1–2 ms vs ~3 ms): the SSR trades the relay's simplicity
  and proven NC behaviour for no coil power, near-free pre-arm hold, no bounce/wear, and isolation.

**Plan:** K1 + K2 → one **1-Form-A AC PhotoMOS** part: SUPSiC **GAQY212GS** (JLCPCB C7435107 —
SPST-NO, AC/DC, 0.24 Ω Ron, 60 V, 800 mA, 30 mA LED, SOP-4). Vs the **GAQY212GSX** (C19271988) it's
a **wash** — every distinguishing spec falls outside our operating regime: GSX's lower Ron (180 mΩ)
and higher current (1 A) buy nothing (Ron swamped by R16 2.2 kΩ / the near-short; 800 mA already ~10×
a mA-class door signal), and its higher LED drive (50 vs 30 mA) is also moot since both exceed GPIO
source and sit behind a buffer regardless. Price delta is ~€0.09, so not a factor either. GS picked
as the base/more-reliably-stocked part; GSX is an equally valid swap if banking current headroom
against the unmeasured K2 door current (bench 7). K3 → NC relay **or** the **GAQY412EH** 1-Form-B
NC-SSR (C7435135) — both viable (NC confirmed, Ron/current/AC OK); pick on coil-power/pre-arm/wear
vs simplicity, not speed. Going SSR collapses most of the relay-driver coil circuitry and its power
budget. Two bench currents gate sizing: **K2 door-signal current** and **K3 gong speaker-drive
current** (we scoped bus voltages, not either current).

**Schematic structure — retire the `relay_driver.kicad_sch` hierarchical sheet.** It's currently
instantiated 3× (K1/K2/K3), each a G6K + 2N7002 + 1N4148W flyback + 100 Ω + 10 kΩ coil-driver. SSRs
kill that reuse two ways: (a) the SSR "driver" is just an LED + series R (no coil → **no flyback**,
no coil-kick, no pull-down-for-coil) — too trivial to wrap in a sheet; (b) the three are no longer
identical (K1/K2 = GAQY212GS NO SOP-4; K3 = GAQY412EH NC SMD-4 or a relay). **Place the SSRs flat.**
Drive: K3/GAQY412EH ~7 mA → GPIO-direct via ~300 Ω (no transistor); K1/K2/GAQY212GS — confirm its LED
current, keep a small 2N7002 buffer (repurposed from the old block) if tens of mA, but drop the
flyback. The one surviving flyback is on the **WF26_K1 coil** (Decision 6b), not any SSR. (A single
*non-reused* "switching" page grouping the SSRs + latch + line-4 protection is fine for tidiness, but
that's organisation, not the reuse pattern.) Executed in the coherent refactor pass.

**Current-headroom sanity check (normal operation; fault survival is out of scope — SAFE-7
sacrificial).**
- **K1** — most over-margined: R16's 2.2 kΩ is in series, so K1 can't carry > ~12 V / 2.2 kΩ ≈ 5 mA
  (incl. cap inrush, R16-limited) short of a fault shorting R16. ~160× under 800 mA. No concern.
- **K3** — steady ~80 mA gong / 26 mA door-open = 6× under 500 mA. One transient to note: the **C1
  (22 µF) re-charge inrush** if firmware *closes K3 while line-4 DC is already up* (un-mute
  mid-session) → worst-case ~530 mA for <1 ms (τ ≈ 350 µs); within the GAQY412EH's 0.6 A / 100 ms
  peak rating (datasheet), though only ~13 % under it in the stiff-source worst case. NOT
  present in normal always-closed operation (slow 12 ms pedestal → ~16 mA) or release-at-idle; and
  ring4's soft 12 ms pedestal implies a high-impedance line-4 source, so realistic inrush is tens of
  mA. Mitigations if needed: don't close K3 hot (firmware), or a small series R in the C1 branch;
  confirm the GAQY412EH surge spec.
- **K2** — the one unmeasured value (bench 7): mimics the WF26's *direct* P2↔P3 short, current set by
  the TV20/S. Under "not ~12 W / 1 A", the 800 mA continuous / 2 A peak covers it; scope both the
  steady door current and the closing inrush into P3's line capacitance.
- **WF26_K1** (passive latch, HJR-4102-N, *not* replaced) — fine by construction: coil ~29 mA at the
  9.22 V hold (native 12 V-relay operating point), contacts carry only the ~30 mA self-hold + mA audio
  (door goes via K2, not here) vs ~1–2 A contact rating; our high-Z additions don't shift its pull-in.
  Its only sizing-adjacent issue is the unclamped-coil kick → see Decision 6b (add coil flyback/TVS).

**Audio quality — the SSRs are transparent; quality lives elsewhere.** Two switches sit in audio
paths (K3 in the C1→speaker acoustic path; K1 in the R16→P3 TX path; K2 is a momentary actuator, not
in-path). Their Ron is negligible against the series impedance it works into — K3's 1 Ω vs the 16 Ω
speaker is −0.5 dB (and barely shifts C1's existing high-pass, so the stock WF26 acoustic signature is
preserved); K1's sub-Ω vs R16's 2.2 kΩ is ~0.01 %. MOSFET-in-ohmic-region distortion is swamped by
those same series R's (well below the TV20/S LM380/TAA861A amps), and off-state isolation (10 GΩ /
pF Coff) makes muting clean. The only artifact to manage is **switching pops**, which is firmware/
timing, not hardware: K3 switches inside the 13–16 ms pre-tone window (into silence); K1's talk-on
step is the DC-block cap charging through R16 — i.e. the handshake itself, identical to the WF26's R1
press that the TV20/S already tolerates (still mute/ramp the codec DAC before toggling K1). PhotoMOS
is if anything *better* than the V3 relays for audio (no contact bounce, no oxidation drift on dry
low-level switching); the relay's mΩ-vs-1 Ω edge is inaudible. Real quality drivers: the ES8311 + its
front-end, R16 level-set (AUDIO-6, don't overdrive the amp), RX differential CMRR/hum (bench 6),
speaker, and the TV20/S amps.

## Requirements impact (for the later REQUIREMENTS.md pass)
- **MODE-2/3/4** collapse to a single replacement mode; add "exactly one (passive) WF26 always in the
  loop" (now the on-board core).
- **GONG** becomes unconditionally available (no parallel conflict).
- **New safety requirement to add:** only the **Türruf** (building door, low criticality) is
  suppressible; the **Etagenruf** (apartment-door bell) MUST remain audible in all states. The C1
  placement makes this a hardware invariant — capture it as a requirement so the property is
  protected against future layout/placement changes, not left as an emergent side effect.
- **BUS-1** stays but reframes from "don't double-load a parallel WF26" to "present a WF26-equivalent
  load to the *shared* bus" (other apartments still share 1/2/3).
- **AUDIO-4** satisfied structurally (AC-coupled taps, no DC on the bus, high-Z RX).
- **AUDIO-5 / SAFE-3** isolation downgraded to *not met* (justified by the P1≈earth measurement);
  **SAFE-7** met via the protection network, not a galvanic barrier.

## Open bench items (must verify before committing)
1. **Gong-suppress timing** — confirm the pedestal→tone gap (≥~10 ms) and that a step-driven K3 mutes
   inside it; measure where the chime becomes audible vs the pedestal rise.
2. **C1 is the only line-4→LS1 path** (so cutting C1 fully kills the gong).
3. **TX-out reach / full-duplex** — does the TV20/S forward line-3 talk to the door station, and does
   it tolerate simultaneous RX+TX at all (prereq for any full-duplex)?
4. **K3 switch time** — step-drive the coil and scope the contact directly (the bus capture can't
   isolate it; datasheet G6K-2F-Y ≈ 3 ms operate is the working assumption).
5. **ES8311 input** — single-ended vs differential (decides whether RX needs an external in-amp).
6. **Hum** with the P1↔GND bond once RX is active.
7. **K2 door-signal current** — confirm it's a mA-class signalling bridge (not strike current routed
   through the handset) before sizing the K2 PhotoMOS.
8. **K3 gong speaker-drive current** — *resolved from ring4 (no handset surgery needed):* the
   speaker/K3 branch current is `V_line4(AC) / |Z_C1+Z_LS1|` (C1 = 22 µF, LS1 = 16 Ω → |Z| ≈ 17.5 Ω
   at 1010 Hz), peaking at **~80 mA** composite / ~26 mA at door-open → ~6× under the GAQY412EH's
   500 mA. (Bench confirmation optional: probe AC volts across LS1, divide by Z.)
