import { readFileSync } from 'node:fs';

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

export const TV20S_CALIBRATION = Object.freeze(readJson('./calibration.json'));
export const TV20S_EVIDENCE = Object.freeze(readJson('./capture-evidence.json'));

export function validateTv20sCalibration(calibration = TV20S_CALIBRATION, evidence = TV20S_EVIDENCE) {
  if (calibration.schema !== 1 || evidence.schema !== 1) throw new Error('unsupported TV20/S calibration schema');
  if (!(calibration.p2.source_resistance_ohm > 0)) throw new Error('TV20/S P2 source resistance must be positive');
  if (!(calibration.p2.timeout_source_resistance_ohm > 0) ||
      calibration.p2.timeout_sink_ms !== calibration.p2.timeout_fall_ms + calibration.p2.timeout_plateau_ms ||
      !(calibration.p2.timeout_fall_tau_ms > 0 && calibration.p2.timeout_recovery_snap_ms > 0 &&
        calibration.p2.timeout_recovery_tau_ms > 0))
    throw new Error('TV20/S timeout calibration requires a positive, internally consistent captured waveform');
  if (!(calibration.ring.pedestal_rise_ms > 0 && calibration.ring.gong_duration_ms > 0))
    throw new Error('TV20/S ring calibration requires positive measured timing');
  const talkRange = calibration.p3?.terminal_classification?.talk_bridge_range_ohm;
  const talkNominal = calibration.p3?.terminal_classification?.talk_bridge_nominal_ohm;
  if (!Array.isArray(talkRange) || talkRange.length !== 2 || !(talkRange[0] > 0) ||
      !(talkRange[1] >= talkRange[0]) || !(talkNominal >= talkRange[0] && talkNominal <= talkRange[1]))
    throw new Error('TV20/S Talk classification requires a positive ordered range containing its nominal value');
  if (!Array.isArray(calibration.supported) || !Array.isArray(calibration.unsupported))
    throw new Error('TV20/S calibration requires explicit supported/unsupported behavior lists');
  for (const [section, captureNames] of Object.entries(calibration.evidence || {})) {
    if (!Array.isArray(captureNames) || !captureNames.length)
      throw new Error(`TV20/S calibration evidence ${section} must name at least one capture`);
    for (const captureName of captureNames)
      if (!evidence.captures?.[captureName])
        throw new Error(`TV20/S calibration evidence ${section} names unknown capture ${captureName}`);
  }
  for (const [name, capture] of Object.entries(evidence.captures || {})) {
    if (!capture.run || !capture.channels || !capture.files)
      throw new Error(`TV20/S evidence ${name} is incomplete`);
    for (const channel of Object.values(capture.channels))
      if (!['confirmed', 'inferred', 'inferred-and-cross-checked'].includes(channel.confidence))
        throw new Error(`TV20/S evidence ${name} has unknown channel confidence ${channel.confidence}`);
  }
  return true;
}
