// Component registry: classify a raw component to its class, and assemble simulation elements.
import { simulate, gndOf } from '../engine.js';

import EsdArray from './EsdArray.js';
import Relay from './Relay.js';
import SolderBridge from './SolderBridge.js';
import Switch from './Switch.js';
import Transformer from './Transformer.js';
import Optocoupler from './Optocoupler.js';
import Ldo from './Ldo.js';
import Mosfet from './Mosfet.js';
import Diode from './Diode.js';
import Inductor from './Inductor.js';
import Capacitor from './Capacitor.js';
import Speaker from './Speaker.js';
import Fuse from './Fuse.js';
import Resistor from './Resistor.js';
import TestPoint from './TestPoint.js';
import Connector from './Connector.js';
import Unmodeled from './Unmodeled.js';

// most-specific first; the first class whose compatible() matches wins
export const REGISTRY = [
  EsdArray,
  Relay,
  SolderBridge,
  Switch,
  Transformer,
  Optocoupler,
  Ldo,
  Mosfet,
  Diode,
  Inductor,
  Capacitor,
  Speaker,
  Fuse,
  Resistor,
  TestPoint,
  Connector,
];

export function classify(comp) {
  const Cls = REGISTRY.find((C) => C.compatible(comp)) || Unmodeled;
  return new Cls(comp);
}

export function allComponents(netlist) {
  return netlist.components.map(classify);
}

// switch state at power-up: solder bridges start closed, everything else open
export function defaultSwitchState(netlist) {
  const ss = {};

  for (const c of allComponents(netlist)) {
    if (c.defaultClosed) ss[c.ref] = true;
  }

  return ss;
}

// every simulation element: each part's model + any hand-added extras
export function buildElements(netlist, { switchState = {}, extra = [] } = {}) {
  const els = [];

  for (const c of allComponents(netlist)) {
    for (const e of c.elements({ switchState })) els.push(e);
  }

  for (const e of extra) els.push(e);

  return els;
}

// high-level scenario for tests: drive `sources` ({net: volts | vf(t)}), set `switches`
// ({ref: pressed?}), inject any hand-built `extra` elements (e.g. a surge through a series resistor);
// returns the final node voltages + floating flags.
export function runDC(netlist, { sources = {}, switches = {}, extra = [], gnd, T = 0.04, dt = 20e-6 } = {}) {
  const switchState = { ...defaultSwitchState(netlist), ...switches };
  const els = buildElements(netlist, { switchState, extra });

  const srcs = Object.entries(sources).map(([net, v]) => ({
    net,
    vf: typeof v === 'function' ? v : () => v,
  }));

  const r = simulate(els, srcs, gnd || gndOf(netlist), T, dt);

  const V = {};
  for (const n in r.v) V[n] = r.v[n][r.v[n].length - 1];

  return { V, floating: r.floating, RES: r };
}
