// Central view model + a tiny observable store. One source of truth for the recording, the visible
// time window, channel visibility/scale, cursors, and audio/playhead state. Modules subscribe and
// re-render on change; main.js owns the data-fetching reactions.

export const store = (() => {
  const subs = new Set();
  const state = {
    recordings: [],
    rec: null, // basename
    meta: null, // /api/meta result
    dataRange: { t0: 0, t1: 1 }, // full record extent (scope time axis)
    window: { t0: 0, t1: 1 }, // visible window
    channels: [], // [{ ch, label, visible, t0, dt, n, vmin, vmax, vmeanDC, wavSampleRate }]
    samples: null, // last getSamples() result
    events: [], // primitive events ([{kind:'edge'|'burst',ch,label,t,tEnd?,...}])
    highlevel: [], // semantic events ([{kind:'hl',type,t,tEnd?,title,detail}])
    timelineMode: 'high', // 'high' (semantic) | 'raw' (primitives)
    showTimeline: true, // event timeline strip under the channels
    activeEvent: null, // index (into the active list) of the currently focused event, or null
    loading: false,
    acMode: false, // subtract per-channel DC
    cursors: { a: null, b: null }, // scope-time values
    drag: null, // { t0, t1 } active region-zoom selection (scope-time), or null
    hover: null, // { t, clientX, clientY } under pointer (null when off-plot)
    hoverEvent: null, // { i, clientX, clientY } when hovering a timeline event
    listenCh: null,
    audio: { playing: false, headTime: null }, // headTime = scope-time of the playhead
    note: null,
    error: null,
  };
  return {
    get: () => state,
    set(patch) {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
      subs.forEach((f) => f(state));
    },
    // mutate nested fields in place, then notify
    update(fn) {
      fn(state);
      subs.forEach((f) => f(state));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
})();

// elapsed seconds from record start (the convention the .md notes use)
export const elapsed = (t) => t - store.get().dataRange.t0;
export const fromElapsed = (e) => e + store.get().dataRange.t0;

export function visibleChannels() {
  return store.get().channels.filter((c) => c.visible);
}

// the event list currently shown on the timeline (semantic or primitive)
export function activeEvents() {
  const s = store.get();
  return s.timelineMode === 'high' ? s.highlevel : s.events;
}

// Representative voltage of a channel at scope-time t, from the current samples block.
// Envelope blocks → bucket midpoint; raw blocks → nearest sample. Returns NaN if out of range.
export function valueAt(block, ch, meta, t) {
  if (!block) return NaN;
  const { t0, dt, i0, mode, step, buckets, data } = block;
  const idx = (t - t0) / dt; // global sample index
  if (mode === 'raw') {
    const j = Math.round(idx - i0);
    if (j < 0 || j >= data.length) return NaN;
    return data[j];
  }
  const b = Math.floor((idx - i0) / step);
  if (b < 0 || b >= buckets) return NaN;
  return (data[2 * b] + data[2 * b + 1]) / 2;
}
