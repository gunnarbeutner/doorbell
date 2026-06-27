# door-open-call-held — a neighbour's call, *we* opened the door (V3 controller, via API), call held on

A passive capture of the STR bus during **another apartment's** door call — but the door-open in the
middle is **ours**: our V3 controller fired the opener over its API (this neighbour has API access to
it), not the neighbour's handset button. Line 4 (our address) stays cold the whole time, so the
*call* isn't ours; we're watching it on the shared bus, the same vantage as `neighbour-ring-door-open`.
The new, telling feature is that the **door-open does *not* end the session** — the call holds for
~51 s afterward. That's the fingerprint of a **controller/relay open** rather than a **handset
door-button** open: pressing the door button on your own handset releases the seal-in and drops the
call (as in `neighbour-ring-door-open`, where the call ended ~1.5 s after the open), whereas our V3 relay just
bridges P2↔P3 without touching the latch. So the one opener we *can* rule out is **the neighbour's own
handset** — the held call proves it.

## Capture

| | |
|---|---|
| Date | 2026-06-22 20:31:53 |
| Sample rate | **25 kSa/s** (Nyquist 12.5 kHz; dt = 40 µs — verified from CSV Δt) |
| Duration / points | 80.00 s, 2,000,000 samples/channel |
| Probe ratio | 10× |
| Channels (grounds on **P1**) | **CH1 = IN_P4 (line 4)**, **CH2 = P2** (shared listen), **CH3 = P3** (talk) — the standard convention; the data fits it (CH1 idles as the 50 Hz antenna, CH2 carries the engage sag + gong, CH3 carries the door bridge). |
| Files | `*-ch{1,2,3}.csv` / `.wav`, `*.png` |

Times are **elapsed seconds** from the start.

## Timeline

| Elapsed | Event |
|---------|-------|
| 0 – 5.62 s | Idle. P2 **+12.133 V**, line 4 **+0.017 V**, P3 **+0.05 V**. Line 4 carries ~1.33 Vpp of **50 Hz** mains hum (high-Z antenna), no DC. |
| **~5.62 s** | **Neighbour's call engages** — P2 sags **12.133 → 9.586 V** (−2.55 V) in one step. Line 4 **does not move** (still 0.017 V). The gong rides in essentially with the step (P2 AC envelope up at **5.609 s**). |
| 5.6 – ~10.2 s | **Gong** on P2: the 3-Klang, **1010 Hz → 840 Hz → 672 Hz** descending, decaying. Gong-band energy **0.69 V RMS on P2**; only **0.03 V on line 4** and **0.05 V on P3** (negligible crosstalk). |
| 10 – 15.9 s | Listen window holds. P2 steady **~9.55 V**, line 4 & P3 cold. |
| **~15.891 s** | **Door-open** — a **P2↔P3 dead short**. P3 snaps **0.16 → 8.04 V**, P2 drops **9.52 → 4.02 V**; they meet at **7.41 V** (P2 = P3 = 7.41 V at 16.03 s — *equal*, a true short, not the 2.2 kΩ talk bridge). |
| 15.89 – ~17.65 s | **Bridged ~1.75 s** — P3 held up (>3 V for 1.75 s, plateau ~5–7 V), P2 pulled down to a matching ~7.4 V plateau. |
| ~17.65 – 18.78 s | **Bridge releases.** P3 snaps back to ~0 V; **P2 recovers only to the call-hold level (~9.58 V), not to 12 V** — the call is still up. |
| 18.78 – 69.67 s | **Session holds — ~51 s.** P2 steady **9.586 V**, line 4 and P3 both flat/cold. No further bursts. |
| **~69.671 s** | **Release** — P2 collapses **9.06 → 2.12 V in ~40 ms**, then **snaps back**: >11.5 V by +46 ms, 12.133 V shortly after. A brief P2-low pulse, not a P2↔P3 bridge. |
| 69.7 – 80 s | Idle. P2 +12.133 V, line 4 & P3 ≈ 0 V. |

Total session: engage **5.62 s** → release **69.67 s** = **~64 s held**, with the door-open at
**~10.3 s into** the call.

## What I think happened

**A neighbour was rung; ~10 s in, *our* V3 controller opened the door over its API (the neighbour has
access to it); the call then held ~51 s before being released.** Reading the bus straight through:

1. **Not our ring.** Line 4 (IN_P4) never leaves 0.017 V — no pedestal, no DC step, just its usual
   1.33 Vpp / 50 Hz antenna hum, unchanged from idle through engage, gong, door, and release. Our
   ring drives line 4 hot (cf. `our-ring-no-door`: line 4 to ~9 V). Here it's dead, so the
   call is on the **shared P2 party line only** — a neighbour's Türruf. **Our OC1 (DC sense on
   line 4) would not trigger** — address-selectivity holds, as in `neighbour-ring-door-open`.
2. **The engage + gong are the standard neighbour-call signature.** P2's −2.55 V sag
   (12.13 → 9.59 V) is the neighbour's latched K5 coil loading the shared line against its source
   impedance — the same −2.5…−2.6 V step seen on every other call. The chime is the familiar
   **1010 / 840 / 672 Hz** 3-Klang (matches `our-ring-no-door`, `our-ring-door-open`, `neighbour-ring-door-open`).
3. **The door opened ~10 s in — a clean P2↔P3 dead short.** P3 yanked to 8 V, P2 down to 4 V, both
   meeting at **7.41 V** (*equal* → true short, not a resistive talk bridge), bridged ~1.75 s — the
   same shape/duration as our standalone opener (`door-open-standalone`). **This was our V3 controller**
   (API-triggered by the neighbour), not the neighbour's handset button — see (4) for the proof. From
   the bus *waveform* alone you can't attribute it: the short carries **no electrical signature of its
   origin** at our tap. The bridge P2−P3 offset is **+0.015 V** here vs **−0.044 V** (our standalone)
   vs **−0.037 V** (the handset open in `neighbour-ring-door-open`) — all equal within the ~0.07 V noise, so bus
   wiring resistance is negligible and any short looks identical to any other. (The meet *level*
   differs — ~7.4 V here vs 7.16 V standalone — only because P2 was already pulled to the 9.55 V
   call-hold before the short, not 12 V idle; it's set by the pre-short P2, not by who shorts.)
   Attribution comes from **behavior, not waveform** — (4).
4. **The door-open did *not* end the call — and *that* is what identifies the opener.** After the
   bridge releases, P2 climbs back only to the **9.58 V hold level**, not to 12 V, and the session
   runs another **~51 s** before release. A **handset** door button releases the seal-in as it opens,
   so a handset open *ends* the call — exactly what `neighbour-ring-door-open` shows (open at ~10 s, call dropped
   by ~12 s, ~1.5 s later). Here the call survives the open by ~51 s, so the opener **did not touch the
   latch** → it was a bare P2↔P3 bridge from **our V3 controller's relay**, not the neighbour's
   handset. So: a door-open is an event *within* a session for a controller open, but a *terminator*
   for a handset open — and the post-open hold tells the two apart.
5. **The end is a plain seal-in release, not a door-open.** At 69.67 s P2 is pulsed low
   (9.06 → 2.12 V) for ~40 ms and snaps back to 12 V — the latched coil losing its P2 supply, the
   same release mechanism as `our-ring-no-door`. P3 doesn't move, so this is a hang-up /
   timeout, not a second door-open.

## Design read

- **No false ring for us.** The whole event is invisible to line 4's DC sense: line 4 holds 0.017 V
  with only sub-volt, DC-free 50 Hz hum throughout. OC1 stays quiet — confirmed again on a full call
  *including* a door-open (the door switching edges couple only as tiny transients onto the line-4
  antenna, no DC step).
- **The codec RX tap (on P2) hears the whole neighbour call.** Engage sag, the 0.69 V-RMS gong, the
  door-open transient, and ~51 s of hold — all on P2, regardless of whose call it is. Same conclusion
  as `neighbour-ring-door-open`: line 2 is the shared party line and our RX sees everyone's traffic.
- **A controller door-open does *not* end the session; a handset door-open does.** This capture is the
  counter-example to "door-open = call over": our V3 relay bridged P2↔P3 mid-call and the session ran
  ~51 s more, because a bare relay short doesn't release the seal-in the way a handset's door button
  does (`neighbour-ring-door-open`: handset open → call dropped ~1.5 s later). So **track session state from the
  P2 engage/release** (the 12 V↔9.6 V hold level), *not* from the door bridge — and note our own opener
  firing won't drop a call in progress (ours or a neighbour's).
- **We can open the door during a call that isn't ours.** The V3 controller (and the V4 board's K2)
  shorts the *shared* P2↔P3, so an API/HA-triggered open works regardless of who's been rung — as it
  did here, on a neighbour's call. A door-open seen on the bus may well be ours even when line 4 never
  fired; "not our ring" does **not** imply "not our open."
- **Gong coupling ranking unchanged:** P2 (0.69) ≫ P3 (0.05) ≈ line 4 (0.03). The chime is loud only
  on the shared listen line; crosstalk onto the other two is at the noise floor.

## Notes

- **Line 4 (CH1) is a high-Z 50 Hz antenna** — ~1.33 Vpp, dominantly 50 Hz, DC-free, constant across
  the entire record. The CH1 spikes visible in the overview at ~16 s and ~70 s are just capacitive
  pickup of the door-open and release **switching edges**, not any drive on line 4 (its DC never
  budges from 0.017 V).
- **P2 hold level 9.586 V** (−2.55 V from 12.13 V idle) is steady to ±0.05 V across the ~51 s hold —
  a clean single-coil load, no second station joining.

Related: `neighbour-ring-door-open` (neighbour ring + **handset** door-open — the call ends
~1.5 s after, the contrast that proves the open here was our controller, not a handset),
`door-open-standalone` (standalone ÖT — our controller's bare P2↔P3 short in isolation, meet
~7.16 V, no seal-in interaction), `our-ring-no-door` (the seal-in release mechanism seen at
69.7 s here). Bus model: `../DESIGN.md` ("Bell signals", "Door opener", "WF26 internal circuit").
