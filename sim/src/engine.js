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
        : e.type === 'SSR'
          ? [e.a, e.b, e.c, e.d]
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
  const branches = all.filter((e) => e.type === 'L' || e.type === 'V');
  branches.forEach((e, i) => (e.bi = N + i));
  const M = N + branches.length,
    Vt = 0.025852,
    Gmin = 1e-12,
    LDO_GM = 1e4, // LDO pass-element transconductance: vout tracks tgt to ~icur/g (a few µV); stiff but stable
    SW_GON = 20; // closed switch / made relay contact = 50 mΩ (realistic contact R, not an ideal 0 Ω short):
  // negligible in load-limited paths, but it keeps a near-short between two stiff sources from drawing kA
  const hasD = all.some(
    (e) => e.type === 'D' || e.type === 'OPTO' || e.type === 'MOS' || e.type === 'LDO' || e.type === 'RC' || e.type === 'SSR',
  );
  const hasLDO = all.some((e) => e.type === 'LDO');
  for (const e of all) {
    if (e.type === 'C') e.vp = 0;
    if (e.type === 'L') e.ip = 0;
    if (e.type === 'D' || e.type === 'OPTO' || e.type === 'SSR') e.vl = 0;
    if (e.type === 'OPTO') e.vl2 = 0;
    if (e.type === 'RC') e.coilOn = false; // relay contact latch state (hysteretic)
    if (e.type === 'SSR') e.ledOn = false; // PhotoMOS LED energized latch (hysteretic, like the relay)
    if (e.type === 'LDO') e.ldoOn = true; // pass element conducting? (gated on input being source-fed, below)
  }
  const vn = new Array(N).fill(0);
  const Vof = (x) => (x === gnd ? 0 : vn[ni[x]] || 0);

  // carry physical state over from a previous stepper (matched by net name / element ref)
  if (seed) {
    if (seed.vn) for (const n in seed.vn) if (n in ni) vn[ni[n]] = seed.vn[n];
    for (const e of all) {
      if (e.type === 'C' && seed.caps && e.ref in seed.caps) e.vp = seed.caps[e.ref];
      if (e.type === 'L' && seed.ind && e.ref in seed.ind) e.ip = seed.ind[e.ref];
      if (e.type === 'RC' && seed.relays && e.ref in seed.relays) e.coilOn = seed.relays[e.ref]; // keep latch
      if (e.type === 'SSR' && seed.ssrs && e.ref in seed.ssrs) e.ledOn = seed.ssrs[e.ref]; // keep PhotoMOS latch
      if (e.type === 'LDO' && seed.ldos && e.ref in seed.ldos) e.ldoOn = seed.ldos[e.ref];
    }
  }
  // settle each LDO's on/off from whether its input is source-fed in the (possibly seeded) initial state,
  // before the first stamp. Otherwise a stale "on" on a now-dead input sinks for one step and pumps the
  // input rail above the supply — which then reverse-biases the feed diode and blocks any later re-feed.
  if (hasLDO) {
    const sr = reachFrom(sources.map((s) => s.net));
    for (const e of all) if (e.type === 'LDO') e.ldoOn = sr.has(e.vin);
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
          gS(a, c, e.closed ? SW_GON : 1e-15);
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
          // Unidirectional pass element: it SOURCES current vin->vout to pull vout up to tgt, drawing the
          // same current from vin (I_in ~ I_out), but it can never SINK (vout->vin). Modeled as a one-sided
          // transconductance icur = g*max(0, tgt - (vout-vgnd)) >= 0, so it is always passive. A stiff ideal
          // source instead would sink when the output cap overshoots tgt, pumping charge uphill into the
          // input and manufacturing energy — that ran a disconnected input rail away to ~100 kV.
          const tgt = Math.min(e.vreg, Math.max(0, Vof(e.vin) - e.drop)),
            o = idx(e.vout),
            gp = idx(e.gnd),
            vi = idx(e.vin),
            g = LDO_GM;
          if (e.ldoOn && tgt > Vof(e.vout) - Vof(e.gnd)) {
            // conducting: transconductance g between vin and vout, referenced to vgnd (vout -> tgt, drawing
            // the same current from vin). Gated above on the input being source-fed AND vout below tgt.
            if (o >= 0) A[o][o] += g;
            if (o >= 0 && gp >= 0) A[o][gp] -= g;
            if (vi >= 0 && o >= 0) A[vi][o] -= g;
            if (vi >= 0 && gp >= 0) A[vi][gp] += g;
            if (o >= 0) b[o] += g * tgt;
            if (vi >= 0) b[vi] -= g * tgt;
          } // else off: vout left to its load/cap (no sinking back into vin)
        } else if (e.type === 'D') {
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
          // contact follows the latched coil state (set once per step with hysteresis), not the
          // instantaneous coil voltage -> models the relay's mechanical lag and avoids chatter
          gS(a, c, e.when === 'always' || (e.when === 'on') === e.coilOn ? SW_GON : 1e-15);
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
        } else if (e.type === 'SSR') {
          // PhotoMOS solid-state relay. Input (LED) side: a diode a->b, exactly like the OPTO LED — its
          // forward current sets the energized state (latched once per step with hysteresis, below). Output
          // side (c<->d): a plain BIDIRECTIONAL linear resistance Ron when conducting, ~open otherwise — it
          // passes both current polarities (no diode/clamp). NO conducts when the LED is energized; NC when
          // it is de-energized. Open conductance << Gmin so it can't leak a stiff source onto a floating net.
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
          const conducts = e.closedWhenOn === e.ledOn;
          gS(idx(e.c), idx(e.d), conducts ? 1 / e.ron : 1e-15);
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
        if (e.type === 'L' || e.type === 'V') e.icur = x[e.bi] || 0; // branch current
      });
      if (!hasD || conv) break;
    }
    // a regulator only works if its input rail is actually fed by a source. On a disconnected input it must
    // switch OFF, not keep regulating a charged cap — that manufactures energy, and the resulting on/off
    // feedback oscillates and stalls the Newton solve. So gate each LDO on whether its vin reaches a source.
    const srcReach = hasLDO ? reachFrom(sources.map((s) => s.net)) : null;
    for (const e of all) {
      if (e.type === 'C') {
        const vcap = Vof(e.a) - Vof(e.b);
        e.icur = (e.value / dt) * (vcap - e.vp); // displacement current i = C·dV/dt this step
        e.vp = vcap;
      }
      if (e.type === 'L') e.ip = e.icur;
      if (e.type === 'LDO') {
        const tgt = Math.min(e.vreg, Math.max(0, Vof(e.vin) - e.drop)),
          head = tgt - (Vof(e.vout) - Vof(e.gnd));
        e.icur = e.ldoOn && head > 0 ? LDO_GM * head : 0; // current sourced vin->vout this step (>= 0)
        e.ldoOn = srcReach.has(e.vin); // gate next step on the input being source-fed
      }
      if (e.type === 'RC') {
        const vc = e.coilA && e.coilB ? Math.abs(Vof(e.coilA) - Vof(e.coilB)) : 0;
        e.coilOn = e.coilOn ? vc >= e.release : vc >= e.pickup; // pick up at >=pickup, drop out at <release
      }
      if (e.type === 'SSR') {
        // latch the LED-energized state from its forward current (operate at >= iop, release at < iop/2),
        // mirroring the relay's hysteretic mechanical lag so the output doesn't chatter near threshold
        const Iled = e.Is * (Math.exp(Math.min((Vof(e.a) - Vof(e.b)) / (e.n * Vt), 40)) - 1);
        e.ledOn = e.ledOn ? Iled >= 0.5 * e.iop : Iled >= e.iop;
      }
    }
  }

  // nets reachable from `seeds` through edges that conduct at the solved operating point (a reverse diode /
  // off FET / open switch doesn't conduct; caps & current-sources don't anchor DC). Used both for the
  // floating map (seed = ground + sources) and the LDO input-power gate (seed = sources only).
  function reachFrom(seeds) {
    const adj = {},
      addE = (x, y) => {
        (adj[x] = adj[x] || []).push(y);
        (adj[y] = adj[y] || []).push(x);
      };
    for (const e of all) {
      if (e.type === 'R' || e.type === 'L') addE(e.a, e.b); // R, and L (a DC short), always conduct
      else if (e.type === 'D') {
        // forward-conducting by current, not a fixed Vf threshold (a Schottky at load drops < 0.4 V)
        if (e.Is * (Math.exp(Math.min((Vof(e.a) - Vof(e.b)) / (e.n * Vt), 40)) - 1) > 1e-6) addE(e.a, e.b);
      }
      else if (e.type === 'SW' && e.closed) addE(e.a, e.b);
      else if (e.type === 'RC') {
        if (e.when === 'always' || (e.when === 'on') === e.coilOn) addE(e.a, e.b);
      } // relay contact: conductive when latched closed
      else if (e.type === 'MOS') {
        if (Vof(e.g) - Vof(e.s) > e.vth) addE(e.d, e.s);
      } // FET only when on
      else if (e.type === 'OPTO') {
        if (Vof(e.a) - Vof(e.b) > 0.4) {
          addE(e.a, e.b);
          addE(e.c, e.e);
        }
      } // opto on -> LED & phototransistor conduct
      else if (e.type === 'SSR') {
        if (Vof(e.a) - Vof(e.b) > 0.4) addE(e.a, e.b); // LED forward-biased conducts (input side)
        if (e.closedWhenOn === e.ledOn) addE(e.c, e.d); // output closed in the latched conducting state
      } // PhotoMOS: input LED + bidirectional output, galvanically isolated from each other
      else if (e.type === 'LDO' && e.ldoOn) addE(e.vin, e.vout); // pass element conducts only while on
    }
    const seen = new Set(seeds),
      stk = [...seeds];
    while (stk.length) {
      const n = stk.pop();
      for (const m of adj[n] || [])
        if (!seen.has(m)) {
          seen.add(m);
          stk.push(m);
        }
    }
    return seen;
  }

  // floating = nets with no DC-conductive path to ground or a source (caps & current-sources don't anchor)
  function floatingMap() {
    const anch = reachFrom([gnd, ...sources.map((s) => s.net)]);
    const floating = {};
    for (const n of nodes) floating[n] = !anch.has(n);
    floating[gnd] = false;
    return floating;
  }

  // snapshot the persistent state so a rebuilt stepper can continue from here (live config change)
  function extractState() {
    const st = { vn: {}, caps: {}, ind: {}, relays: {}, ssrs: {}, ldos: {} };
    for (const n of nodes) st.vn[n] = vn[ni[n]];
    for (const e of all) {
      if (e.type === 'C' && e.ref != null) st.caps[e.ref] = e.vp;
      if (e.type === 'L' && e.ref != null) st.ind[e.ref] = e.ip;
      if (e.type === 'RC' && e.ref != null) st.relays[e.ref] = e.coilOn;
      if (e.type === 'SSR' && e.ref != null) st.ssrs[e.ref] = e.ledOn;
      if (e.type === 'LDO' && e.ref != null) st.ldos[e.ref] = e.ldoOn;
    }
    return st;
  }

  // current injected into each net's copper at each component pad (sign: + into the net), keyed by
  // {ref, pin, net}. Feeds the trace-mesh solver; 0 Ohm contacts/switches and net-level sources are
  // left out (the solver supplies each net's source/connector residual from KCL).
  function padInjections() {
    const out = [];
    // include the ground/return net too — its copper carries the return current and should flow
    const push = (ref, pin, net, I) => {
      if (ref && net && Math.abs(I) > 1e-12) out.push({ ref, pin, net, I });
    };
    for (const e of all) {
      if (e.type === 'R') {
        const I = (Vof(e.a) - Vof(e.b)) / (e.value || 1e12);
        push(e.ref, e.pa, e.a, -I);
        push(e.ref, e.pb, e.b, I);
      } else if (e.type === 'SW' || e.type === 'RC') {
        // a closed switch / made relay contact is a low-R link (G = SW_GON); its current is otherwise
        // invisible to the trace flow, so a net reached only through a contact (e.g. /P4 via K3 + the J3
        // bridge) shows nothing. Conduction state matches the stamp: SW -> e.closed; RC -> latched coil state.
        const on = e.type === 'SW' ? e.closed : e.when === 'always' || (e.when === 'on') === e.coilOn;
        const I = on ? (Vof(e.a) - Vof(e.b)) * SW_GON : 0;
        push(e.ref, e.pa, e.a, -I);
        push(e.ref, e.pb, e.b, I);
      } else if (e.type === 'L' || e.type === 'C') {
        push(e.padRef || e.ref, e.pa, e.a, -(e.icur || 0)); // inductor branch / capacitor displacement current
        push(e.padRef || e.ref, e.pb, e.b, e.icur || 0); // padRef: transformer windings map to the footprint, not "~p"/"~s"
      } else if (e.type === 'D') {
        const I = e.Is * (Math.exp(Math.min((Vof(e.a) - Vof(e.b)) / (e.n * Vt), 40)) - 1);
        push(e.ref, e.pa, e.a, -I);
        push(e.ref, e.pb, e.b, I);
      } else if (e.type === 'MOS') {
        const I = Vof(e.g) - Vof(e.s) > e.vth ? (Vof(e.d) - Vof(e.s)) / e.ron : 0;
        push(e.ref, undefined, e.d, -I);
        push(e.ref, undefined, e.s, I);
      } else if (e.type === 'OPTO') {
        const Id = e.Is * (Math.exp(Math.min((Vof(e.a) - Vof(e.b)) / (e.n * Vt), 40)) - 1);
        push(e.ref, undefined, e.a, -Id);
        push(e.ref, undefined, e.b, Id);
        // collector–emitter current = the CTR current source minus the anti-saturation clamp diode (e->c,
        // Is = 1e-6) that pins Vce once the collector bottoms out; omitting the clamp left the collector and
        // emitter nets up to ~mA out of balance when the phototransistor saturates.
        const Ic = e.ctr * Math.max(0, Id);
        const Iclamp = 1e-6 * (Math.exp(Math.min((Vof(e.e) - Vof(e.c)) / Vt, 40)) - 1);
        push(e.ref, undefined, e.c, -Ic + Iclamp);
        push(e.ref, undefined, e.e, Ic - Iclamp);
      } else if (e.type === 'SSR') {
        // input LED forward current (pins a/b) + the bidirectional output current (pins c/d, only while
        // the latched state conducts) — so both galvanically-isolated sides balance per-net independently.
        const Id = e.Is * (Math.exp(Math.min((Vof(e.a) - Vof(e.b)) / (e.n * Vt), 40)) - 1);
        push(e.ref, e.pa, e.a, -Id);
        push(e.ref, e.pb, e.b, Id);
        const Io = e.closedWhenOn === e.ledOn ? (Vof(e.c) - Vof(e.d)) / e.ron : 0;
        push(e.ref, e.pc, e.c, -Io);
        push(e.ref, e.pd, e.d, Io);
      } else if (e.type === 'LDO') {
        push(e.ref, e.pinVin, e.vin, -(e.icur || 0)); // pass-through current drawn out of the input rail
        push(e.ref, e.pinVout, e.vout, e.icur || 0); // and pushed into the regulated output rail
      }
    }
    return out;
  }

  return { step, floatingMap, extractState, padInjections, vn, ni, nodes, gnd };
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
  const n = netlist.nets;
  const cfg = netlist.config && netlist.config.gnd; // per-board .sim override
  if (cfg && n.includes(cfg)) return cfg;
  // else prefer a real GND; else line-1 common (P1) is the bus reference; else just the first net
  return n.includes('GND') ? 'GND' : n.find((x) => x === '/P1' || x === 'P1') || n[0];
}

export { MULT, parseVal, netV, solve, pnjlim, simulate, createStepper, makeWave, gndOf };
