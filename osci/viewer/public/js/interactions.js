// Pointer + keyboard interaction for the scope canvas. Translates gestures into calls on the `app`
// controller (defined in main.js): region-zoom, wheel-zoom about the pointer, pan, reset, cursor
// placement, hover, and keyboard shortcuts.

import { store } from './viewstate.js';

const CLICK_PX = 4; // movement under this = a click, not a drag

export function attachInteractions(canvas, scope, app) {
  let down = null; // { x, t, pan, alt }

  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;
  const inPlot = (x) => {
    const L = scope.layout;
    return L && x >= L.plot.x && x <= L.plot.x + L.plot.w;
  };
  const inTimeline = (x, y) => {
    const tl = scope.layout?.timeline;
    return tl && y >= tl.y && y <= tl.y + tl.h && x >= tl.x && x <= tl.x + tl.w;
  };
  const hitEvent = (x, y) => (scope.eventHits || []).find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);

  canvas.addEventListener('mousedown', (e) => {
    if (!scope.layout) return;
    const x = localX(e), y = localY(e);
    if (inTimeline(x, y)) {
      const hit = hitEvent(x, y);
      if (hit) app.focusEvent(hit.i);
      e.preventDefault();
      return; // never start a drag/cursor from the event strip
    }
    const t = scope.layout.timeAtX(x);
    down = { x, t, pan: e.altButton || e.button === 1 || e.altKey, startWin: { ...store.get().window } };
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    const L = scope.layout;
    if (!L) return;
    const x = localX(e);
    if (down) {
      const t = L.timeAtX(x);
      if (down.pan) {
        const dt = down.t - t; // shift window opposite to drag
        app.setWindow(down.startWin.t0 + dt, down.startWin.t1 + dt);
      } else if (Math.abs(x - down.x) > CLICK_PX) {
        store.update((s) => { s.drag = { t0: down.t, t1: t }; });
        app.draw();
      }
      return;
    }
    // hover
    const y = localY(e);
    if (inTimeline(x, y)) {
      const hit = hitEvent(x, y);
      store.update((s) => { s.hover = null; s.hoverEvent = hit ? { i: hit.i, clientX: e.clientX, clientY: e.clientY } : null; });
      app.refreshHud();
    } else if (inPlot(x) && y >= L.plot.y && y <= L.plot.y + L.plot.h) {
      store.update((s) => { s.hover = { t: L.timeAtX(x), clientX: e.clientX, clientY: e.clientY }; s.hoverEvent = null; });
      app.refreshHud();
    } else if (store.get().hover || store.get().hoverEvent) {
      store.update((s) => { s.hover = null; s.hoverEvent = null; });
      app.refreshHud();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!down) return;
    const L = scope.layout;
    const x = localX(e);
    const moved = Math.abs(x - down.x);
    if (!down.pan && moved <= CLICK_PX) {
      // click → place a cursor
      const t = L ? L.timeAtX(down.x) : down.t;
      app.placeCursor(e.shiftKey ? 'b' : 'a', t);
    } else if (!down.pan && moved > CLICK_PX && L) {
      const a = down.t, b = L.timeAtX(x);
      app.setWindow(Math.min(a, b), Math.max(a, b));
    }
    store.update((s) => { s.drag = null; });
    down = null;
    app.draw();
  });

  canvas.addEventListener('mouseleave', () => {
    if (store.get().hover || store.get().hoverEvent) {
      store.update((s) => { s.hover = null; s.hoverEvent = null; });
      app.refreshHud();
    }
  });

  canvas.addEventListener('dblclick', () => app.resetView());

  canvas.addEventListener('wheel', (e) => {
    const L = scope.layout;
    if (!L) return;
    e.preventDefault();
    const x = localX(e);
    if (e.shiftKey) {
      const span = store.get().window.t1 - store.get().window.t0;
      app.panBy((e.deltaY > 0 ? 0.15 : -0.15) * span);
    } else {
      const factor = Math.exp((e.deltaY || 0) * 0.0015);
      app.zoomAbout(L.timeAtX(x), factor);
    }
  }, { passive: false });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
    const span = store.get().window.t1 - store.get().window.t0;
    const hoverT = store.get().hover?.t ?? store.get().audio.headTime;
    switch (e.key) {
      case ' ': e.preventDefault(); app.togglePlay(); break;
      case '0': case 'Home': app.resetView(); break;
      case '+': case '=': app.zoomAbout((store.get().window.t0 + store.get().window.t1) / 2, 0.6); break;
      case '-': case '_': app.zoomAbout((store.get().window.t0 + store.get().window.t1) / 2, 1.6); break;
      case 'ArrowLeft': app.panBy(-0.2 * span); break;
      case 'ArrowRight': app.panBy(0.2 * span); break;
      case 'a': if (hoverT != null) app.placeCursor('a', hoverT); break;
      case 'b': if (hoverT != null) app.placeCursor('b', hoverT); break;
      case 'x': app.clearCursors(); break;
      case 'd': app.toggleAC(); break;
      case 'e': app.toggleTimeline(); break;
      case 'f': app.toggleFFT(); break;
      case 's': app.toggleSpectrogram(); break;
      case 'c': app.playFromCursor(); break;
      case 'w': app.playWindow(); break;
      case '1': case '2': case '3': case '4': case '5': app.setListen(Number(e.key)); break;
      default: return;
    }
  });
}
