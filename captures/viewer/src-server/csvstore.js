// Parse a channel CSV (`time_s,volt`, uniform sample rate) into a compact numeric record.
//
// The time axis is uniform, so we never store it: time of sample i is t0 + i*dt. We keep only a
// Float32Array of true voltages (~4 bytes/sample) plus t0, dt and a few precomputed stats. dt is
// derived from the first and last timestamps (robust to last-digit jitter in the scientific-notation
// text), not from adjacent-row deltas.

import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const zstdDecompress = promisify(zlib.zstdDecompress);
const NL = 10; // '\n'
const COMMA = 44; // ','

async function readDecompressed({ path, compressed }) {
  const buf = await readFile(path);
  return compressed ? await zstdDecompress(buf) : buf;
}

// Parse decompressed CSV bytes -> { t0, dt, n, volts, vmin, vmax, vmeanDC }.
export function parseCsvBuffer(buf) {
  const len = buf.length;

  // skip the header line
  let i = 0;
  while (i < len && buf[i] !== NL) i++;
  i++; // past the newline

  // count remaining newlines for an exact-enough allocation (upper bound on data rows)
  let rows = 0;
  for (let j = i; j < len; j++) if (buf[j] === NL) rows++;
  if (i < len && buf[len - 1] !== NL) rows++; // final unterminated line
  const volts = new Float32Array(rows);

  let k = 0;
  let t0 = NaN;
  let tLastStr = null;
  let vmin = Infinity;
  let vmax = -Infinity;
  let sum = 0;
  let lineStart = i;

  const emit = (start, end) => {
    // line = [start, end); split at the first comma
    let c = start;
    while (c < end && buf[c] !== COMMA) c++;
    if (c >= end) return; // malformed
    const v = parseFloat(buf.toString('latin1', c + 1, end));
    if (k === 0) t0 = parseFloat(buf.toString('latin1', start, c));
    tLastStr = [start, c]; // remember bounds; parse only the actual last one
    volts[k++] = v;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
    sum += v;
  };

  for (let j = i; j < len; j++) {
    if (buf[j] === NL) {
      if (j > lineStart) emit(lineStart, j);
      lineStart = j + 1;
    }
  }
  if (lineStart < len) emit(lineStart, len); // trailing line without newline

  const n = k;
  const tLast = tLastStr ? parseFloat(buf.toString('latin1', tLastStr[0], tLastStr[1])) : t0;
  const dt = n > 1 ? (tLast - t0) / (n - 1) : 1;
  return {
    t0,
    dt,
    n,
    volts: n === volts.length ? volts : volts.subarray(0, n),
    vmin: n ? vmin : 0,
    vmax: n ? vmax : 0,
    vmeanDC: n ? sum / n : 0,
  };
}

export async function parseChannelSource(source) {
  const buf = await readDecompressed(source);
  return parseCsvBuffer(buf);
}
