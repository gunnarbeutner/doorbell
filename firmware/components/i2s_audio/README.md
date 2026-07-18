# Patched ESPHome i2s_audio component

This is the `i2s_audio` component from ESPHome 2026.7.0, carried locally to use the `keep_alive`
speaker option proposed in
[esphome/esphome#15565](https://github.com/esphome/esphome/pull/15565). The PR changes were ported
from commit `83443ec03019d7b4e72573bacd007537e6358768`. The vendored files retain ESPHome's licensing;
see `LICENSE` in this directory.

With `keep_alive: true`, stopping a standard I2S speaker disables its channel but keeps the allocated,
configured channel for the next playback with the same stream format. A different stream format still
deletes and rebuilds the channel. Both firmware configurations prime the channel once at boot while K1
keeps the codec output disconnected from P3, and log whether the speaker transitions through RUNNING
to STOPPED. Subsequent welcome playback reuses the retained channel; it is not gated on a persistent
boot-readiness flag.

Both `doorbell.yaml` and `doorbell-bench.yaml` select this local component. When upgrading ESPHome,
compare it with the new upstream version. Remove the local override if the PR (or an equivalent fix)
has landed; otherwise refresh the parent and `speaker/` files from the new baseline and reapply the
small keep-alive change. The 2026.7 refresh includes upstream's wider-input narrowing support for
standard I2S speakers; the keep-alive reuse check therefore compares both input and clocked-output formats.
