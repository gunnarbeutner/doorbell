// Client for the viewer's HTTP API.

export async function getRecordings() {
  const r = await fetch('/api/recordings');
  if (!r.ok) throw new Error('recordings failed');
  return (await r.json()).recordings;
}

export async function getMeta(rec) {
  const r = await fetch(`/api/meta?rec=${encodeURIComponent(rec)}`);
  if (!r.ok) throw new Error(`meta failed: ${await r.text()}`);
  return r.json();
}

export async function getEvents(rec) {
  const r = await fetch(`/api/events?rec=${encodeURIComponent(rec)}`);
  if (!r.ok) return { events: [], highlevel: [] };
  const j = await r.json();
  return { events: j.events || [], highlevel: j.highlevel || [] };
}

export async function getNote(rec) {
  const r = await fetch(`/api/note?rec=${encodeURIComponent(rec)}`);
  if (!r.ok) return null;
  return r.text();
}

export const wavUrl = (rec, ch) => `/api/wav?rec=${encodeURIComponent(rec)}&ch=${ch}`;
export const pngUrl = (rec) => `/osci-asset/${encodeURIComponent(rec)}.png`;

// Fetch decimated samples for several channels. Returns { channels: { ch: block } } where a block is
// { ch, mode, buckets, step, i0, i1, t0, dt, len, data:Float32Array }.
export async function getSamples(rec, chs, t0, t1, px, signal) {
  const url = `/api/samples?rec=${encodeURIComponent(rec)}&ch=${chs.join(',')}` +
    `&t0=${t0}&t1=${t1}&px=${Math.round(px)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`samples failed: ${await r.text()}`);
  const meta = JSON.parse(r.headers.get('X-Osci-Meta'));
  const buf = await r.arrayBuffer();
  const out = {};
  let floatOff = 0;
  for (const c of meta.channels) {
    out[c.ch] = { ...c, data: new Float32Array(buf, floatOff * 4, c.len) };
    floatOff += c.len;
  }
  return { channels: out, t0, t1, px };
}
