# Patched ESPHome speaker component

This is the `speaker` component from ESPHome 2026.6.5, carried locally so the doorbell firmware can
apply the stale announcement-pipeline state workaround proposed in
[esphome/esphome#15692](https://github.com/esphome/esphome/issues/15692).
The vendored files retain ESPHome's licensing; see `LICENSE` in this directory.

The local change is confined to `media_player/audio_pipeline.cpp`: it clears stale reader/decoder
completion bits when starting new media and resets the pipeline's stop/finishing state. Both
`doorbell.yaml` and `doorbell-bench.yaml` select this directory through `external_components`.

When upgrading ESPHome, compare this entire component with the new upstream version. Remove the local
override if the issue has been fixed upstream; otherwise refresh the vendored files and reapply the
small `audio_pipeline.cpp` change.
