// Small formatting + math helpers shared across the frontend.

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Format a duration in seconds with an engineering unit.
export function fmtTime(s, digits = 3) {
  const a = Math.abs(s);
  if (a === 0) return '0 s';
  if (a >= 1) return `${s.toFixed(digits)} s`;
  if (a >= 1e-3) return `${(s * 1e3).toFixed(digits)} ms`;
  return `${(s * 1e6).toFixed(0)} µs`;
}

// Compact time for axis ticks (fewer digits).
export function fmtTimeShort(s) {
  const a = Math.abs(s);
  if (a >= 1) return `${(+s.toFixed(3)).toString()}s`;
  if (a >= 1e-3) return `${(+(s * 1e3).toFixed(3)).toString()}ms`;
  if (a >= 1e-6) return `${(+(s * 1e6).toFixed(1)).toString()}µs`;
  return `${(s * 1e9).toFixed(0)}ns`;
}

export function fmtVolt(v, digits = 3) {
  if (Math.abs(v) >= 1) return `${v.toFixed(digits)} V`;
  return `${(v * 1e3).toFixed(0)} mV`;
}

export function fmtFreq(hz) {
  if (!isFinite(hz)) return '—';
  if (hz >= 1000) return `${(hz / 1000).toFixed(3)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

// "Nice" tick values (1/2/5 × 10^k) spanning [min,max], ~targetCount of them.
export function niceTicks(min, max, targetCount = 6) {
  if (!(max > min)) return [min];
  const raw = (max - min) / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) out.push(t);
  return out;
}

// DPR-correct sizing for a canvas; returns the CSS pixel { w, h }.
export function fitCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
