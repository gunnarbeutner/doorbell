// Per-recording channel labels (bus-line names). Seeded from the server defaults, overridable in the
// UI, and persisted to localStorage keyed by recording basename.

const KEY = 'osci-viewer-labels';

function all() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function labelFor(rec, ch, fallback) {
  const o = all();
  return o[rec]?.[ch] ?? fallback;
}

export function setLabel(rec, ch, label) {
  const o = all();
  (o[rec] ||= {})[ch] = label;
  localStorage.setItem(KEY, JSON.stringify(o));
}
