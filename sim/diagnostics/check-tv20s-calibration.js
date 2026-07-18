import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { TV20S_CALIBRATION, TV20S_EVIDENCE, validateTv20sCalibration } from
  '../src/tv20s/calibration.js';

const repo = new URL('../../', import.meta.url);
const sha256 = (url) => createHash('sha256').update(readFileSync(url)).digest('hex');

validateTv20sCalibration();
for (const capture of Object.values(TV20S_EVIDENCE.captures)) {
  for (const [name, expected] of Object.entries(capture.files)) {
    const url = new URL(`captures/runs/${capture.run}/${name}`, repo);
    const actual = sha256(url);
    if (actual !== expected)
      throw new Error(`${capture.run}/${name} changed: expected ${expected}, got ${actual}`);
  }
}

const c = TV20S_CALIBRATION;
const derived = {
  one_session_p2_v: c.p2.idle_v / (1 + c.p2.source_resistance_ohm / 320),
  idle_door_meet_v: c.p2.idle_v * c.p3.door_idle_sink_ohm /
    (c.p2.source_resistance_ohm + c.p3.door_idle_sink_ohm),
  held_door_meet_v: c.p2.idle_v /
    (1 + c.p2.source_resistance_ohm / 320 + c.p2.source_resistance_ohm / c.p3.door_session_sink_ohm),
};

const within = (value, range) => value >= range[0] && value <= range[1];
if (!within(derived.one_session_p2_v, c.p2.single_session_observed_v))
  throw new Error(`one-session P2 ${derived.one_session_p2_v} is outside its captured envelope`);
if (!within(derived.idle_door_meet_v, c.p3.door_idle_observed_v))
  throw new Error(`idle door meet ${derived.idle_door_meet_v} is outside its captured envelope`);
if (!within(derived.held_door_meet_v, c.p3.door_session_observed_v))
  throw new Error(`held door meet ${derived.held_door_meet_v} is outside its captured envelope`);

process.stdout.write(`${JSON.stringify({ calibration: c.id, derived }, null, 2)}\n`);
