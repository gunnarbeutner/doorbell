# DHO804 setup for bench welcome-audio captures

This is the repeatable setup for capturing a complete embedded welcome file, including its onset, on
the Rigol DHO804 at `osci.beutner.name`. Do not rely on the scope's retained state: a flat battery or
power cycle can reset acquisition, trigger, coupling, probe and scaling settings independently.

The settings below are for the current bench connection: **CH1 on P3, physical probe at 1×, bus not
connected**. If the intercom bus is connected, first apply the isolation and grounding rules in
`VERIFICATION.md`; do not copy this bench grounding arrangement onto a live bus.

## Known-good full-file setup

Use these settings for the 6.123 s Windows welcome file:

| Setting | Value | Reason |
| --- | --- | --- |
| Channel | CH1 enabled, 1× probe, AC coupling | Matches the physical P3 probe and removes the DC pedestal |
| Vertical | 200 mV/div, 0 V offset | Shows the roughly 1.75 Vpp playback without clipping |
| Timebase mode | `MAIN` | A triggered acquisition does not work in ROLL mode |
| Horizontal | 1 s/div, +4 s offset | Produces a 10 s record from −1 s to +9 s around the trigger |
| Memory | 1 Mpts | Gives 100 kSa/s over 10 s, ample for audio and transient inspection |
| Trigger | Edge, CH1, rising, 200 mV | Audio triggers even when there is no separate switching impulse |
| Sweep/run | NORMAL, SINGLE | Captures once and leaves the result frozen |

The order matters after a reset. Stop the scope, select MAIN, temporarily select automatic memory,
set the timebase, then select 1 Mpts. A fixed deep-memory setting can otherwise constrain or reject a
slow timebase change.

```text
:STOP
:TIM:MODE MAIN
:ACQ:MDEP AUTO
:TIM:SCAL 1
:TIM:OFFS 4
:ACQ:MDEP 1M
:CHAN1:DISP ON
:CHAN1:PROB 1
:CHAN1:COUP AC
:CHAN1:SCAL 0.2
:CHAN1:OFFS 0
:TRIG:MODE EDGE
:TRIG:EDGE:SOUR CHAN1
:TRIG:EDGE:SLOP POS
:TRIG:EDGE:LEV 0.2
:TRIG:SWE NORM
:SING
```

## Arm before starting playback

After `:SING`, poll `:TRIG:STAT?` until it returns **`WAIT`** before pressing the ESPHome playback
button. This takes roughly 1.5 s with the settings above. The 10 s record has 1 s of pre-trigger memory,
and the DHO804 must fill it before it can preserve the onset. Starting after only 0.5 s produced a
valid-looking trace whose left edge was already mid-file.

If the status remains `RUN`, do not start playback: either the pre-trigger buffer is not ready yet or
the memory/timebase changes did not land in the required order. A correctly armed NORMAL single
acquisition returns `WAIT`; after the trigger and record complete it returns `STOP`.

Avoid putting an LLM/tool round trip between arming and playback. Configure the scope, wait for `WAIT`
and POST the select/button endpoints in one local command or script:

```text
POST http://192.168.3.78/select/Next-ring%20greeting/set?option=Windows
POST http://192.168.3.78/button/Play%20Welcome%20Sound/press
```

Wait at least 9 s after the button press. The single acquisition should then be stopped already; send
`:STOP` once more before reading memory, and leave it stopped so the complete waveform remains on the
scope display. A status query with a short socket timeout can time out while the scope finalizes 1 Mpt
of deep memory. Reconnect and use `capture.py`, whose STOP wait allows up to two minutes.

## Read the frozen waveform

Use `capture.py --screen`, not `--record`: `--record` deliberately uses AUTO/free-run acquisition and
is not an onset-trigger workflow. `--screen` reads the frozen deep memory and trims it to exactly what
the display shows.

```sh
cd captures
.venv/bin/python capture.py --screen --channels 1 --probe 1 --out welcome-windows
```

For temporary analysis without adding a run under the repository, an absolute output path works:

```sh
.venv/bin/python capture.py --screen --channels 1 --probe 1 \
  --out /tmp/welcome-windows --no-plot
```

## Failure signatures

- **Display says `Waveform View(ROLL)`**: trigger acquisition is not configured. Stop, set MAIN, and
  reapply NORMAL + SINGLE.
- **Trace begins with substantial audio at the left edge**: playback began before pre-trigger memory
  was ready. Re-arm and require `WAIT` before the button press.
- **Only idle is captured**: playback was triggered after the acquisition window. Keep arm, wait and
  HTTP button press in one local operation.
- **Amplitude is off by exactly 10×**: the scope's probe ratio does not match the physical 1× switch.
- **RAW read fails or returns incomplete memory**: explicitly stop the scope and wait for `STOP` before
  running `capture.py`.
- **Settings appear not to land after a battery reset**: reapply the entire sequence in the order
  above; do not patch individual remembered settings.
