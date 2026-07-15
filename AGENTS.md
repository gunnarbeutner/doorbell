# Doorbell controller repository guide

This repository contains an ESP32/ESPHome interface for an STR TV20/S apartment intercom. The board
is one complete WF26-compatible handset endpoint: its passive WF26 core still rings, listens, talks
and opens the door without logic power, while the smart layer adds Home Assistant integration.
Connecting a separate WF26 handset in parallel is unsupported.

The installed V4.1 board provides useful field evidence, while the current KiCad sources describe
the V4.2 candidate. Do not claim that changed V4.2 circuitry is field-proven merely because the
corresponding V4.1 function works.

## Sources of truth

- `REQUIREMENTS.md` defines required behavior and safety properties.
- `DESIGN.md` explains the current architecture and rationale.
- `kicad/doorbell.kicad_sch` and `kicad/doorbell.kicad_pcb` are authoritative for the hardware.
- `firmware/doorbell.yaml` is the production ESPHome configuration;
  `firmware/doorbell-bench.yaml` is its bench-safe counterpart.
- `wf26/wf26.kicad_sch` captures the reverse-engineered passive handset.
- `VERIFICATION.md` is the reusable pre-fab verification procedure. Open work belongs in `TODO.md`.
- Exact parts and ordering instructions belong in the schematic and `ORDERING.md`.

Keep requirements, design rationale, schematic/PCB behavior, firmware comments and tests consistent.
Do not copy transient tool versions, warning counts or report results into durable documentation.
Keep bench firmware behavior aligned with production except for the safety and diagnostic differences
documented at the top of `firmware/doorbell-bench.yaml`.

## Verification

Use the narrowest relevant check while iterating:

```sh
./build.sh verify       # ERC, placement, PCB connectivity/DRC and simulation tests; no exports
./build.sh schematic    # schematic ERC and PDF export
./build.sh pcb          # placement, connectivity and DRC
./build.sh simulation   # simulator unit tests
cd sim && npm test      # simulator tests directly
```

`./build.sh` with no argument performs the complete release build and regenerates order-ready
artifacts. Run it only when release outputs are intentionally in scope. Validate firmware changes
against both ESPHome YAML files with `esphome config` when the local ESPHome environment is available.
Before using the bench DHO804, follow the wiring, MAIN/non-ROLL trigger, pre-trigger timing and capture
procedure in [`captures/DHO804-SETUP.md`](captures/DHO804-SETUP.md); do not rely on retained scope
settings after a power cycle or flat battery.
The build currently expects the macOS KiCad paths embedded in `build.sh`; if that toolchain is absent,
report the unavailable check rather than changing project paths merely to make the local run pass.

On macOS, KiCad 10's `kicad-cli pcb drc` must be run outside Codex's restricted process sandbox.
Inside the sandbox it traps in `SwiftNativeNSArray` with `Array index out of range`, even for a newly
created empty PCB; this is a macOS application/display-services access problem, not evidence of a bad
board object. Retry the identical DRC command with escalated access before attempting to isolate PCB
contents. Fontconfig warnings are unrelated. Zone edits still require refilling and saving the copper
pours before the final DRC/parity run.

Simulator tests import the current KiCad schematic at runtime. There is no generated or baked netlist
to update separately. Add a regression test for safety-sensitive behavior whenever the simulator can
reasonably model it.

## Editing rules

- Edit the KiCad sources directly; scripts verify and export them but do not author the board.
- Preserve unrelated user changes in the worktree and stage only files relevant to the task.
- Do not create a commit unless the user explicitly requests one.
- `fab/` is generated and ignored. Do not hand-edit generated Gerbers, BOM, CPL or STEP files.
- Keep `kicad/doorbell.pdf` unchanged unless the user explicitly requests a new schematic PDF.
- `prefab-report.html` is an external review artifact, not a source file; do not edit or commit it.
- When changing hardware behavior, update proportionate tests plus `REQUIREMENTS.md`, `DESIGN.md`,
  `VERIFICATION.md` or `TODO.md` as applicable.

## Repository map

- `tools/`: placement, routing, BOM/CPL and STEP verification/export utilities.
- `sim/`: schematic-importing circuit simulator and unit tests.
- `captures/`: oscilloscope captures from the real TV20/S bus.
- `docs/`: datasheets, design references and ordering material.
- `firmware/`: production and bench ESPHome configurations.
