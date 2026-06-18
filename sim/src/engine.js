// engine.js — the simulation core: value parsing + MNA transient solver (no DOM, no device
// models). Device models live in src/components/. Shared by the UI and the test suite.

const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1 };
function parseVal(s) {
  if (s == null) return null;
  s = ('' + s).replace(/µ/g, 'u').replace(/Ω/g, 'R');
  let r = s.match(/(\d+)([pnumkKMGRr])(\d+)/);
  if (r) return parseFloat(r[1] + '.' + r[3]) * (MULT[r[2]] || 1); // 4R7 / 1k2 notation
  let m = s.match(/(\d*\.?\d+)\s*([pnumkKMGRr])?/);
  if (!m) return null; // first numeric token anywhere (e.g. "Speaker/Mic 16R", "100R/0.25W")
  let mm = m[2] != null ? MULT[m[2]] : 1;
  return parseFloat(m[1]) * (mm == null ? 1 : mm);
}
function netV(n) {
  const m = ('' + n).match(/[+]?(\d+)V(\d*)/i);
  return m ? parseFloat(m[2] ? m[1] + '.' + m[2] : m[1]) : null;
}
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (p !== i) {
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
    }
    const pv = A[i][i] || 1e-18;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / pv;
      if (!f) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / (A[i][i] || 1e-18);
  }
  return x;
}
function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const a = 1 + (vnew - vold) / vt;
      vnew = a > 0 ? vold + vt * Math.log(a) : vcrit;
    } else vnew = vt * Math.log(vnew / vt);
  }
  return vnew;
}
// Build a stateful stepper: the matrix setup plus a per-step Newton solve, with the reactive state
// (node voltages, cap charges, inductor currents) persisting across step() calls. An optional `seed`
// carries that state over from a prior configuration, so a live change continues mid-run instead of
// restarting from t = 0. `simulate()` below is just the batch driver over this.
function createStepper(els, sources, gnd, dt, seed) {
  const vsrc = sources.map((s, i) => ({ type: 'V', a: s.net, b: gnd, vf: s.vf, name: 'S' + i }));
  const all = els.concat(vsrc);
  const enets = (e) =>
    e.type === 'MOS'
      ? [e.g, e.d, e.s]
      : e.type === 'OPTO'
        ? [e.a, e.b, e.c, e.e]
        : e.type === 'LDO'
          ? [e.vin, e.vout, e.gnd]
          : [e.a, e.b];
  const nset = new Set();
  for (const e of all) for (const n of enets(e)) if (n !== gnd) nset.add(n);
  const nodes = [...nset],
    ni = {};
  nodes.forEach((n, i) => (ni[n] = i));
  const N = nodes.length;
  const idx = (x) => (x === gnd ? -1 : ni[x]);
  const branches = all.filter((e) => e.type === 'L' || e.type === 'V' || e.type === 'LDO');
  branches.forEach((e, i) => (e.bi = N + i));
  const M = N + branches.length,
    Vt = 0.025852,
    Gmin = 1e-12;
  const hasD = all.some(
    (e) => e.type === 'D' || e.type === 'OPTO' || e.type === 'MOS' || e.type === 'LDO' || e.type === 'RC',
  );
  for (const e of all) {
    if (e.type === 'C') e.vp = 0;
    if (e.type === 'L') e.ip = 0;
    if (e.type === 'D' || e.type === 'OPTO') e.vl = 0;
    if (e.type === 'OPTO') e.vl2 = 0;
  }
  const vn = new Array(N).fill(0);
  const Vof = (x) => (x === gnd ? 0 : vn[ni[x]] || 0);

  // carry physical state over from a previous stepper (matched by net name / element ref)
  if (seed) {
    if (seed.vn) for (const n in seed.vn) if (n in ni) vn[ni[n]] = seed.vn[n];
    for (const e of all) {
      if (e.type === 'C' && seed.caps && e.ref in seed.caps) e.vp = seed.caps[e.ref];
      if (e.type === 'L' && seed.ind && e.ref in seed.ind) e.ip = seed.ind[e.ref];
    }
  }

  // advance one Backward-Euler timestep to time t, Newton-iterating the nonlinear devices
  function step(t) {
    const mx = hasD ? 100 : 1;
    for (let it = 0; it < mx; it++) {
      const A = Array.from({ length: M }, () => new Array(M).fill(0)),
        b = new Array(M).fill(0);
      for (let i = 0; i < N; i++) A[i][i] += 1e-12;
      const gS = (a, c, g) => {
        if (a >= 0) {
          A[a][a] += g;
          if (c >= 0) A[a][c] -= g;
        }
        if (c >= 0) {
          A[c][c] += g;
          if (a >= 0) A[c][a] -= g;
        }
      };
      const iS = (a, c, I) => {
        if (a >= 0) b[a] -= I;
        if (c >= 0) b[c] += I;
      };
      for (const e of all) {
        const a = idx(e.a),
          c = idx(e.b);
        if (e.type === 'R') {
          gS(a, c, 1 / (e.value || 1e12));
        } else if (e.type === 'SW') {
          gS(a, c, e.closed ? 1e3 : 1e-15);
        } // open << Gmin so it can't leak source V onto a floating node
        else if (e.type === 'C') {
          const g = (e.value || 0) / dt;
          gS(a, c, g);
          iS(a, c, -g * e.vp);
        } else if (e.type === 'L') {
          const g = (e.value || 1e-9) / dt;
          if (a >= 0) {
            A[a][e.bi] += 1;
            A[e.bi][a] += 1;
          }
          if (c >= 0) {
            A[c][e.bi] -= 1;
            A[e.bi][c] -= 1;
          }
          A[e.bi][e.bi] -= g + (e.dcr || 0);
          b[e.bi] += -g * e.ip; // dcr = series winding resistance
          if (e.coupL) {
            const gm = e.M / dt;
            A[e.bi][e.coupL.bi] -= gm;
            b[e.bi] += -gm * e.coupL.ip;
          }
        } // mutual coupling (transformer)
        else if (e.type === 'V') {
          if (a >= 0) {
            A[a][e.bi] += 1;
            A[e.bi][a] += 1;
          }
          if (c >= 0) {
            A[c][e.bi] -= 1;
            A[e.bi][c] -= 1;
          }
          b[e.bi] += e.vf(t);
        } else if (e.type === 'LDO') {
          const tgt = Math.min(e.vreg, Math.max(0, Vof(e.vin) - e.drop)),
            o = idx(e.vout),
            gp = idx(e.gnd);
          if (o >= 0) {
            A[o][e.bi] += 1;
            A[e.bi][o] += 1;
          }
          if (gp >= 0) {
            A[gp][e.bi] -= 1;
            A[e.bi][gp] -= 1;
          }
          b[e.bi] += tgt;
        } // regulated output, floored at 0 (no input -> 0, not -drop); ideal, no input-current draw
        else if (e.type === 'D') {
          const Is = e.Is,
            nVt = e.n * Vt,
            vc = nVt * Math.log(nVt / (Math.SQRT2 * Is));
          const vd = pnjlim(Vof(e.a) - Vof(e.b), e.vl, nVt, vc);
          e.vl = vd;
          const ex = Math.exp(Math.min(vd / nVt, 40));
          let I = Is * (ex - 1),
            g = (Is / nVt) * ex + Gmin;
          if (e.vbr) {
            const exz = Math.exp(Math.min((-vd - e.vbr) / nVt, 40));
            I -= Is * (exz - 1);
            g += (Is / nVt) * exz;
          } // reverse breakdown (Zener / TVS clamp) at vbr
          gS(a, c, g);
          iS(a, c, I - g * vd);
        } // per-part diode model
        else if (e.type === 'MOS') {
          gS(idx(e.d), idx(e.s), Vof(e.g) - Vof(e.s) > e.vth ? 1 / e.ron : 1e-10);
        } else if (e.type === 'RC') {
          const en = e.coilA && e.coilB ? Math.abs(Vof(e.coilA) - Vof(e.coilB)) >= e.pullin : false;
          gS(a, c, e.when === 'always' || (e.when === 'on') === en ? 1e3 : 1e-15);
        } // open << Gmin
        else if (e.type === 'OPTO') {
          const Is = e.Is,
            nVt = e.n * Vt,
            vc = nVt * Math.log(nVt / (Math.SQRT2 * Is));
          const vd = pnjlim(Vof(e.a) - Vof(e.b), e.vl, nVt, vc);
          e.vl = vd;
          const ex = Math.exp(Math.min(vd / nVt, 40)),
            Id = Is * (ex - 1),
            gd = (Is / nVt) * ex + Gmin;
          gS(a, c, gd);
          iS(a, c, Id - gd * vd);
          iS(idx(e.c), idx(e.e), e.ctr * Math.max(0, Id)); // collector sinks CTR*Iled

          // Anti-saturation clamp: a stiff diode from emitter to collector. Once the collector is
          // dragged down to the emitter it conducts hard, pinning Vce ~ 0 (a real phototransistor
          // bottoms out near Vce(sat), not below its emitter). Its own Is (1e-6) keeps the forward
          // drop ~0.2 V at the clamp current while leaking < 1 µA when reverse-biased (off state).
          const sIs = 1e-6,
            svc = Vt * Math.log(Vt / (Math.SQRT2 * sIs));
          const vs = pnjlim(Vof(e.e) - Vof(e.c), e.vl2, Vt, svc);
          e.vl2 = vs;
          const exs = Math.exp(Math.min(vs / Vt, 40)),
            Is2 = sIs * (exs - 1),
            gs2 = (sIs / Vt) * exs + Gmin;
          gS(idx(e.e), idx(e.c), gs2);
          iS(idx(e.e), idx(e.c), Is2 - gs2 * vs);
        }
      }
      const x = solve(A, b);
      let conv = true; // SPICE-style |Δv| < reltol·|v| + vntol (a pure
      for (let i = 0; i < N; i++) {
        const xi = x[i] || 0;
        if (Math.abs(xi - vn[i]) > 1e-3 * Math.abs(xi) + 1e-6) conv = false;
        vn[i] = xi;
      } // absolute tol limit-cycles on low-current diode nodes)
      all.forEach((e) => {
        if (e.type === 'L' || e.type === 'V') e.icur = x[e.bi] || 0;
      });
      if (!hasD || conv) break;
    }
    for (const e of all) {
      if (e.type === 'C') e.vp = Vof(e.a) - Vof(e.b);
      if (e.type === 'L') e.ip = e.icur;
    }
  }

  // floating = nets with no DC-conductive path to ground or a source (caps & current-sources don't anchor)
  function floatingMap() {
    const adj = {},
      addE = (x, y) => {
        (adj[x] = adj[x] || []).push(y);
        (adj[y] = adj[y] || []).push(x);
      };
    for (const e of all) {
      // conductive edges at the solved operating point (a reverse diode / off FET doesn't anchor)
      if (e.type === 'R' || e.type === 'L')
        addE(e.a, e.b); // R, and L (a DC short), always conduct
      else if (e.type === 'D') {
        if (Vof(e.a) - Vof(e.b) > 0.4) addE(e.a, e.b);
      } // diode only when forward-conducting
      else if (e.type === 'SW' && e.closed) addE(e.a, e.b);
      else if (e.type === 'RC') {
        const en = e.coilA && e.coilB ? Math.abs(Vof(e.coilA) - Vof(e.coilB)) >= e.pullin : false;
        if (e.when === 'always' || (e.when === 'on') === en) addE(e.a, e.b);
      } // relay contact: conductive when closed
      else if (e.type === 'MOS') {
        if (Vof(e.g) - Vof(e.s) > e.vth) addE(e.d, e.s);
      } // FET only when on
      else if (e.type === 'OPTO') {
        if (Vof(e.a) - Vof(e.b) > 0.4) {
          addE(e.a, e.b);
          addE(e.c, e.e);
        }
      } // opto on -> LED & phototransistor conduct
      else if (e.type === 'LDO') addE(e.vin, e.vout); // output anchored only when its input is powered
    }
    const anch = new Set([gnd]),
      stk = [gnd];
    for (const s of sources) {
      anch.add(s.net);
      stk.push(s.net);
    }
    while (stk.length) {
      const n = stk.pop();
      for (const m of adj[n] || [])
        if (!anch.has(m)) {
          anch.add(m);
          stk.push(m);
        }
    }
    const floating = {};
    for (const n of nodes) floating[n] = !anch.has(n);
    floating[gnd] = false;
    return floating;
  }

  // snapshot the persistent state so a rebuilt stepper can continue from here (live config change)
  function extractState() {
    const st = { vn: {}, caps: {}, ind: {} };
    for (const n of nodes) st.vn[n] = vn[ni[n]];
    for (const e of all) {
      if (e.type === 'C' && e.ref != null) st.caps[e.ref] = e.vp;
      if (e.type === 'L' && e.ref != null) st.ind[e.ref] = e.ip;
    }
    return st;
  }

  return { step, floatingMap, extractState, vn, ni, nodes, gnd };
}

// Batch transient: step from t = 0 to T and collect the full waveforms (used by the tests + batch run).
function simulate(els, sources, gnd, T, dt) {
  const sim = createStepper(els, sources, gnd, dt);
  const steps = Math.max(1, Math.round(T / dt));
  const out = { t: [], v: {} };
  for (const n of sim.nodes) out.v[n] = [];
  out.v[sim.gnd] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k * dt;
    sim.step(t);
    out.t.push(t);
    for (const n of sim.nodes) out.v[n].push(sim.vn[sim.ni[n]]);
    out.v[sim.gnd].push(0);
  }
  out.floating = sim.floatingMap();
  return out;
}
function makeWave(s) {
  const A = +s.v1,
    O = +s.v2,
    f = +s.freq,
    t1 = +s.t1 / 1000;
  switch (s.type) {
    case 'dc':
      return (t) => A;
    case 'sine':
      return (t) => O + A * Math.sin(2 * Math.PI * f * t);
    case 'square':
      return (t) => O + A * (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1);
    case 'step':
      return (t) => (t < t1 ? O : A);
    case 'pulse':
      return (t) => (t >= t1 && (t - t1) % (1 / f) < 0.5 / f ? A : O);
    default:
      return (t) => 0;
  }
}
function gndOf(netlist) {
  return netlist.nets.includes('GND') ? 'GND' : netlist.nets[0];
}

export { MULT, parseVal, netV, solve, pnjlim, simulate, createStepper, makeWave, gndOf };
