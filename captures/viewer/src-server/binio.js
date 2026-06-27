// Pack several per-channel Float32 blocks into one binary body plus a JSON header.
//
// Wire format: response body is the concatenation of each channel's Float32 block (little-endian,
// as produced by Float32Array on every mainstream platform — and consumed the same way by the
// browser's Float32Array). The X-Osci-Meta response header carries the JSON describing how to slice
// it: per channel { ch, mode, buckets, step, i0, i1, t0, dt, len } where len = number of floats.

// blocks: [{ ch, meta, data:Float32Array }]
export function packSamples(blocks) {
  let total = 0;
  for (const b of blocks) total += b.data.length;

  const merged = new Float32Array(total);
  let off = 0;
  const channels = [];
  for (const b of blocks) {
    merged.set(b.data, off);
    channels.push({ ch: b.ch, ...b.meta, len: b.data.length });
    off += b.data.length;
  }
  return {
    meta: { channels },
    body: Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength),
  };
}
