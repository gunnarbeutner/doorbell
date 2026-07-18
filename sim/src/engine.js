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
function createStepper(els, sources, gnd, dt, seed, { strictConvergence = true, maxNewtonIterations = 250 } = {}) {
  if (!Number.isInteger(maxNewtonIterations) || maxNewtonIterations < 1)
    throw new RangeError('maxNewtonIterations must be a positive integer');
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
  const branches = all.filter((e) => e.type === 'L' || e.type === 'V' || e.type === 'LDO');
  branches.forEach((e, i) => (e.bi = N + i));
  const M = N + branches.length,
    Vt = 0.025852,
    Gmin = 1e-12,
    SW_GON = 20; // closed manual switch = 50 mΩ (realistic contact R, not an ideal 0 Ω short):
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
    if (e.type === 'RC') {
      e.coilOn = false; // relay contact latch state (hysteretic)
      e.pickupElapsed = 0;
      e.releaseElapsed = 0;
    }
    if (e.type === 'SSR') {
      e.ledOn = false; // PhotoMOS LED energized latch (hysteretic, like the relay)
      e.targetOn = false;
      e.switchElapsed = 0;
    }
    if (e.type === 'FUSE') {
      e.melt = 0;
      e.blown = false;
    }
    if (e.type === 'LDO') e.ldoOn = false; // cold start off; VIN must rise before the pass element conducts
  }
  const vn = new Array(N).fill(0);
  const Vof = (x) => (x === gnd ? 0 : vn[ni[x]] || 0);

  // carry physical state over from a previous stepper (matched by net name / element ref)
  if (seed) {
    if (seed.vn) for (const n in seed.vn) if (n in ni) vn[ni[n]] = seed.vn[n];
    for (const e of all) {
      if (e.type === 'C' && seed.caps && e.ref in seed.caps) e.vp = seed.caps[e.ref];
      if (e.type === 'L' && seed.ind && e.ref in seed.ind) e.ip = seed.ind[e.ref];
      if (e.type === 'RC' && seed.relays && e.ref in seed.relays) {
        e.coilOn = seed.relays[e.ref]; // keep latch
        e.releaseElapsed = seed.relayTimers?.[e.ref]?.releaseElapsed || 0;
        e.pickupElapsed = seed.relayTimers?.[e.ref]?.pickupElapsed || 0;
      }
      if (e.type === 'SSR' && seed.ssrs && e.ref in seed.ssrs) {
        e.ledOn = seed.ssrs[e.ref]; // keep PhotoMOS latch
        e.targetOn = seed.ssrTimers?.[e.ref]?.targetOn ?? e.ledOn;
        e.switchElapsed = seed.ssrTimers?.[e.ref]?.switchElapsed || 0;
      }
      if (e.type === 'FUSE' && seed.fuses && e.ref in seed.fuses) {
        e.blown = Boolean(seed.fuses[e.ref].blown);
        e.melt = seed.fuses[e.ref].melt || 0;
      }
      if (e.type === 'LDO' && seed.ldos && e.ref in seed.ldos) e.ldoOn = seed.ldos[e.ref];
    }
  }
  // A carried LDO state is valid only while its seeded input still has dropout headroom and its output
  // is not externally overdriven. A cold run starts with the pass element off; the first solved step
  // establishes VIN, then the normal state update enables regulation without inventing a feed path.
  if (hasLDO) {
    for (const e of all) if (e.type === 'LDO' && e.ldoOn) {
      const input = Vof(e.vin) - Vof(e.gnd);
      const target = Math.min(e.vreg, Math.max(0, input - e.drop));
      e.ldoOn = input > e.drop && Vof(e.vout) - Vof(e.gnd) <= target + 1e-3;
    }
  }

  // advance one Backward-Euler timestep to time t, Newton-iterating the nonlinear devices
  function step(t) {
    const mx = hasD ? maxNewtonIterations : 1;
    let converged = !hasD;
    let worstDelta = 0;
    let worstNode = '';
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
      const vccsS = (op, on, ip, inn, gm) => {
        if (op >= 0 && ip >= 0) A[op][ip] += gm;
        if (op >= 0 && inn >= 0) A[op][inn] -= gm;
        if (on >= 0 && ip >= 0) A[on][ip] -= gm;
        if (on >= 0 && inn >= 0) A[on][inn] += gm;
      };
      for (const e of all) {
        const a = idx(e.a),
          c = idx(e.b);
        if (e.type === 'R') {
          gS(a, c, 1 / (e.value || 1e12));
        } else if (e.type === 'I') {
          e.icur = typeof e.vf === 'function' ? e.vf(t) : e.value || 0;
          iS(a, c, e.icur);
        } else if (e.type === 'FUSE') {
          gS(a, c, e.blown ? 1e-12 : 1 / (e.ron || 1e-3)); // a near-short until it melts open, then ~open
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
          // Regulating pass branch: constrain VOUT-GND to min(vreg, VIN-drop) while transferring the
          // output branch current back to VIN. Including the branch in both KCL equations conserves power
          // flow (the regulator does not create load current at its output). `ldoOn` is gated by a real
          // source-fed path to VIN, so a disconnected input cannot regulate a charged output forever.
          const tgt = Math.min(e.vreg, Math.max(0, Vof(e.vin) - e.drop)),
            o = idx(e.vout),
            gp = idx(e.gnd),
            vi = idx(e.vin);
          if (e.ldoOn) {
            if (o >= 0) A[o][e.bi] += 1;
            if (gp >= 0) A[gp][e.bi] -= 1;
            if (vi >= 0) A[vi][e.bi] -= 1; // draw from VIN exactly what the output branch delivers
            if (o >= 0) A[e.bi][o] += 1;
            if (gp >= 0) A[e.bi][gp] -= 1;
            b[e.bi] += tgt;
          } else {
            A[e.bi][e.bi] += 1; // off branch: zero current, output left to its load/cap
          }
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
          gS(a, c, e.when === 'always' || (e.when === 'on') === e.coilOn ? 1 / (e.ron || 0.05) : 1e-15);
        } // open << Gmin
        else if (e.type === 'OPTO') {
          const Is = e.Is,
            nVt = e.n * Vt,
            vc = nVt * Math.log(nVt / (Math.SQRT2 * Is));
          const vd = pnjlim(Vof(e.a) - Vof(e.b), e.vl, nVt, vc);
          e.vl = vd;
          const ex = Math.exp(Math.min(vd / nVt, 40)),
            Id = Is * (ex - 1),
            dId = (Is / nVt) * ex,
            gd = dId + Gmin;
          gS(a, c, gd);
          iS(a, c, Id - gd * vd);
          // Linearize the CTR-controlled collector current against LED voltage as a VCCS. Treating it
          // as a fixed current from the previous Newton iterate can produce a two-state limit cycle.
          const oc = idx(e.c), oe = idx(e.e);
          if (Id > 0) {
            vccsS(oc, oe, a, c, e.ctr * dId);
            iS(oc, oe, e.ctr * (Id - dId * vd));
          }
          iS(oc, oe, e.darkCurrent || 0);

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
      worstDelta = 0;
      worstNode = '';
      const nextV = new Array(N);
      for (let i = 0; i < N; i++) {
        const xi = x[i] || 0;
        nextV[i] = xi;
        const delta = Math.abs(xi - vn[i]);
        if (delta > worstDelta) {
          worstDelta = delta;
          worstNode = nodes[i];
        }
        if (delta > 1e-3 * Math.abs(xi) + 1e-6) conv = false;
      } // absolute tol limit-cycles on low-current diode nodes)
      // Damped Newton update prevents a forward/off pair of diode states from alternating forever on
      // weakly anchored nodes. Once the raw solve meets tolerance, accept the exact solution.
      const alpha = !hasD || conv ? 1 : 0.5;
      for (let i = 0; i < N; i++) vn[i] += alpha * (nextV[i] - vn[i]);
      all.forEach((e) => {
        if (e.type === 'L' || e.type === 'V' || e.type === 'LDO') e.icur = x[e.bi] || 0; // branch current
      });
      if (!hasD || conv) {
        converged = true;
        break;
      }
    }
    if (!converged && strictConvergence)
      throw new Error(`nonlinear solve did not converge at t=${t.toExponential(6)} s (max |Δv|=${worstDelta.toExponential(3)} V at ${worstNode} after ${mx} iterations)`);
    for (const e of all) {
      if (e.type === 'C') {
        const vcap = Vof(e.a) - Vof(e.b);
        e.icur = (e.value / dt) * (vcap - e.vp); // displacement current i = C·dV/dt this step
        e.vp = vcap;
      }
      if (e.type === 'L') e.ip = e.icur;
      if (e.type === 'LDO') {
        const branchCurrent = e.icur || 0;
        const delivery = e.ldoOn ? -branchCurrent : 0;
        e.icur = Math.max(0, delivery); // reported source delivery vin->vout (>= 0)
        const input = Vof(e.vin) - Vof(e.gnd);
        const output = Vof(e.vout) - Vof(e.gnd);
        const target = Math.min(e.vreg, Math.max(0, input - e.drop));
        // This idealized regulator is one-quadrant: it may source its output, never sink an externally
        // overdriven rail or conduct backward into VIN. A negative delivery request is the matrix telling
        // us that holding the target would require sinking, so release the pass branch on the next step.
        e.ldoOn = input > e.drop && delivery >= -1e-9 && output <= target + 1e-3;
      }
      if (e.type === 'RC') {
        const vc = e.coilA && e.coilB ? Math.abs(Vof(e.coilA) - Vof(e.coilB)) : 0;
        if (e.coilOn) {
          if (vc <= e.release) {
            e.releaseElapsed += dt;
            if (e.releaseElapsed >= (e.releaseTime || 0)) {
              e.coilOn = false;
              e.pickupElapsed = 0;
              e.releaseElapsed = 0;
            }
          } else {
            e.releaseElapsed = 0;
          }
        } else if (vc >= e.pickup) {
          // Must-operate is a *static* voltage.  A coil close to that threshold has almost no excess
          // magnetic force above its return spring, so it cannot complete an operation in the same time
          // as a nominal-voltage coil.  Integrate that excess force (roughly proportional to I²) instead
          // of treating every voltage above pickup as a full-strength 3 ms command.  This matters for
          // K5: the measured gong-cap reclose pulse starts near 10 V and decays through 9.6 V without
          // moving the armature, even though 9.6 V is its DC must-operate specification.
          const den = (e.nominal || e.pickup) ** 2 - e.pickup ** 2;
          const drive = den > 0 ? Math.max(0, (vc ** 2 - e.pickup ** 2) / den) : 1;
          e.pickupElapsed += dt * drive;
          e.coilOn = e.pickupElapsed >= (e.operate || 0);
          if (e.coilOn) e.releaseElapsed = 0;
        } else {
          e.pickupElapsed = 0;
        }
      }
      if (e.type === 'SSR') {
        // Guaranteed LED operate/recovery hysteresis plus optically specified turn-on/off delays.
        const vLed = Vof(e.a) - Vof(e.b);
        const Iled = e.Is * (Math.exp(Math.min(vLed / (e.n * Vt), 40)) - 1);
        const iOperate = e.iOperate ?? e.iop;
        const iRelease = e.iRelease ?? 0.5 * iOperate;
        let target = e.ledOn;
        if (e.ledOn) {
          if (Iled <= iRelease || (e.vRelease != null && vLed <= e.vRelease)) target = false;
        } else if (Iled >= iOperate) {
          target = true;
        }
        if (target !== e.targetOn) {
          e.targetOn = target;
          e.switchElapsed = 0;
        }
        if (target !== e.ledOn) {
          e.switchElapsed += dt;
          const delay = target ? (e.tOperate || 0) : (e.tRelease || 0);
          if (e.switchElapsed >= delay) {
            e.ledOn = target;
            e.switchElapsed = 0;
          }
        } else {
          e.switchElapsed = 0;
        }
      }
      if (e.type === 'FUSE') {
        // melting-I²t fuse: integrate the over-rating current; once the melt energy is reached it latches
        // open (the SAFE-7 fail-safe — a clamping TVS or a short blows it and disconnects the board).
        const I = e.blown ? 0 : (Vof(e.a) - Vof(e.b)) / (e.ron || 1e-3);
        e.icur = I;
        e.melt = (e.melt || 0) + (Math.abs(I) > e.irate ? I * I * dt : 0);
        if (!e.blown && e.melt >= e.i2t) e.blown = true;
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
      else if (e.type === 'FUSE') {
        if (!e.blown) addE(e.a, e.b); // an intact fuse conducts; once blown it is open (board fused off)
      } else if (e.type === 'D') {
        // conducting by current — forward (a Schottky at load drops < 0.4 V) OR reverse breakdown (a TVS /
        // Zener clamping past vbr is a real path: it bleeds a charged node, so the node isn't "floating").
        const vd = Vof(e.a) - Vof(e.b);
        const fwd = e.Is * (Math.exp(Math.min(vd / (e.n * Vt), 40)) - 1);
        const rev = e.vbr ? e.Is * (Math.exp(Math.min((-vd - e.vbr) / (e.n * Vt), 40)) - 1) : 0;
        if (fwd > 1e-6 || rev > 1e-6) addE(e.a, e.b);
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
    const st = { vn: {}, caps: {}, ind: {}, relays: {}, relayTimers: {}, ssrs: {}, ssrTimers: {}, fuses: {}, ldos: {} };
    for (const n of nodes) st.vn[n] = vn[ni[n]];
    for (const e of all) {
      if (e.type === 'C' && e.ref != null) st.caps[e.ref] = e.vp;
      if (e.type === 'L' && e.ref != null) st.ind[e.ref] = e.ip;
      if (e.type === 'RC' && e.ref != null) {
        st.relays[e.ref] = e.coilOn;
        st.relayTimers[e.ref] = { pickupElapsed: e.pickupElapsed, releaseElapsed: e.releaseElapsed };
      }
      if (e.type === 'SSR' && e.ref != null) {
        st.ssrs[e.ref] = e.ledOn;
        st.ssrTimers[e.ref] = { targetOn: e.targetOn, switchElapsed: e.switchElapsed };
      }
      if (e.type === 'FUSE' && e.ref != null) st.fuses[e.ref] = { blown: e.blown, melt: e.melt || 0 };
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
      } else if (e.type === 'I') {
        const I = e.icur || 0;
        push(e.ref, e.pa, e.a, -I);
        push(e.ref, e.pb, e.b, I);
      } else if (e.type === 'FUSE') {
        const I = e.blown ? 0 : (Vof(e.a) - Vof(e.b)) / (e.ron || 1e-3);
        push(e.ref, e.pa, e.a, -I);
        push(e.ref, e.pb, e.b, I);
      } else if (e.type === 'SW' || e.type === 'RC') {
        // a closed switch / made relay contact is a low-R link; its current is otherwise
        // invisible to the trace flow, so a net reached only through a contact (e.g. /P4 through K3)
        // shows nothing. Conduction state matches the stamp: SW -> e.closed; RC -> latched coil state.
        const on = e.type === 'SW' ? e.closed : e.when === 'always' || (e.when === 'on') === e.coilOn;
        const gon = e.type === 'RC' ? 1 / (e.ron || 0.05) : SW_GON;
        const I = on ? (Vof(e.a) - Vof(e.b)) * gon : 0;
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
        const Ic = e.ctr * Math.max(0, Id) + (e.darkCurrent || 0);
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
