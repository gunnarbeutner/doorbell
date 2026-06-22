# our-ring-door-open — our own ring + door-open (the clean one)

A full, correctly-ordered capture of **our own** house-door ring followed by a door-open, with
**IN_P4 and P4 bridged** (so CH1 reads line 4 directly, WF26 coil + C1 in the loop). This is the
recording that pinned the session model: **a ~1 s TV20/S pulse on line 4 latches K5, the handset
then holds line 4 via the P2 seal-in, and a door-open ends it** (its S1 transfer breaks the seal-in).

Supersedes `ring-20260617-180939`, which was a partial/wrapped single-shot read (only ~500 k of
the 5 M buffer); read whole, the event is coherent — there was no scramble.

## Capture

| | |
|---|---|
| Date | 2026-06-17 19:52:21 |
| Sample rate | 25 kSa/s |
| Duration / points | 180.0 s, 4,499,999 samples/channel |
| Probe ratio | 10× |
| Channels (grounds on **P1**) | **CH1 = IN_P4 (= P4, bridged)**, **CH2 = P2**, **CH3 = P3** |
| Files | `*-ch{1,2,3}.csv` / `.wav`, `*.png` |

Times are **elapsed seconds** from the start.

## Timeline

| Elapsed | Event |
|---------|-------|
| 0 – 149 s | Idle. P2 +12.06 V, P3 & line 4 ≈ 0 V. |
| **~149.5 s** | **Ring** — line 4 (IN_P4 = P4) goes hot, P2 drops toward ~9.3 V; **gong on the front** (1010 / 3032 Hz, decaying over ~150–153 s). |
| **150 – 159.2 s** | **Session held** — line 4 steady at **9.20 V**, P2 at **9.32 V** (tied via K1 = listen path); gong AC at the start, then flat DC. ~9.7 s. |
| **159.25 s** | **Door-open** — P3 jumps 0 → 7 V, and **line 4 collapses 9.20 → 0 V in the same 50 ms.** P2↔P3 bridge to ~7.2 V. |
| ~159.5 – 160.4 s | P2↔P3 held at ~7.2 V (the ÖT short). |
| ~160.5 – 162.5 s | Door-open releases; P2 recovers to 12 V. |
| 162.5 s + | Idle. |

## What it confirms — the session model

- **Line 4 is held by the *handset*, not the TV20/S.** Line 4 sits steady at 9.20 V for ~9.7 s (gong
  riding the front) — but **0.12 V below P2 (9.32 V)**, because it's pulled up *from P2* through the
  latched K5 contact. The TV20/S only **pulses line 4 high for ~1 s** to pull K5 in; after
  that the **handset seals the latch in from P2** (`P2 → S1 NC → K1_COM → contact → line 4 → coil`) and
  holds line 4 itself. (The earlier "line 4 only pulses ~1.5 s" was the partial-read artifact of
  `ring-…180939`; read whole, line 4 holds — held by the handset.)
- **No handset, no hold.** A session needs a handset present to seal line 4 in: with P4 floating
  (nothing to seal in) the TV20/S's ~1 s pulse just dies → brief (~0.4–1 s) kick, no session. (See
  `our-ring-p4-floating`, the floating-P4 capture, and `neighbour-ring-door-open`.)
- **The door-open ends it by breaking the seal-in — *not* by the TV20/S dropping line 4.** At 159.25 s
  line 4 collapses to 0 *while P2 only sags to 7.2 V* — well above the coil's release, so P2 would still
  hold the latch **if it still reached it**. But the door-release **S1 is a break-before-make DPDT
  transfer** that opens **P2↔K1_COM** (the seal-in path) as it makes the P2↔P3 bridge, so P2 no longer
  reaches the coil. (`our-ring-after-neighbour` resolves this to a ~6 ms break-before-make, with P2 *rising* as the coil
  load comes off it — the seal-in is real; the transfer breaks it.)
- **P2 is the listen tap *and* the supply**, tied to line 4 via K1 during the call (line 4 tracks
  ~0.12 V below it), and the ÖT line the door-open shorts to P3.
- **Gong:** 1010 / 3032 Hz, matching the other captures (the ~1010 / 841 / 672 Hz 3-Klang).

## Notes

- **IN_P4↔P4 was bridged** for this run, so CH1 is line 4 itself (no separate P4 probe needed).
- The door-open landed ~9.7 s after the gong onset (the board's 1.75 s door-open delay may pad the
  press-to-fire gap); the exact gap doesn't affect the conclusion.

Related: `neighbour-ring-door-open` (neighbour ring), `door-open-standalone` (standalone
ÖT), `our-ring-p4-floating` (floating-P4, kick-only), `idle-20260617-143740`. Bus model:
`../DESIGN.md` ("Bell signals", "WF26 internal circuit").
