// Base class for every modeled part. A subclass declares which KiCad symbols it handles
// (static compatible) and how it turns into simulation elements (elements()).
import { parseVal } from '../engine.js';

export class Component {
  static kind = 'unknown';

  // does this class model the given raw component { ref, lib, value, pins, pinfn }?
  static compatible(c) {
    return false;
  }

  constructor(c) {
    this.ref = c.ref;
    this.lib = c.lib || '';
    this.value = c.value || '';
    this.footprint = c.footprint || '';
    this.pins = c.pins || {};
    this.pinfn = c.pinfn || {};
  }

  get kind() {
    return this.constructor.kind;
  }

  get modeled() {
    return true; // false only for unsupported parts (real ICs) -> shown red
  }

  get role() {
    return null; // 'relay' | 'switch' | 'bridge' for the toggle panel
  }

  get defaultClosed() {
    return false;
  }

  elements(ctx) {
    return []; // ctx = { switchState, program }
  }

  // Optional behavioural driver sources a part declares for itself (e.g. a codec DAC core, an ESP GPIO
  // driver) — kept INSIDE the part so a testbench injects only the real external rails (VBUS/GND/bus).
  // Default: none. (Most parts realise their drivers as V+bleed elements in elements() instead.)
  sources(ctx) {
    return [];
  }

  // ---- safety invariants ----
  // Given solved node voltages `vn` (net -> volts), return any pin/terminal that is outside its datasheet
  // absolute-maximum window: [{ ref, pin, net, v, lo, hi, why }]. Default: a part declares no limits.
  // Limits live HERE (next to the part's electrical model) rather than in a net registry, so they are
  // expressed relative to the part's OWN supply/ground pins and can't drift when the schematic is re-netted.
  checkSafe(vn) {
    return [];
  }

  // push a violation iff the finite value `v` falls outside [lo, hi] (small tolerance).
  chk(out, pin, net, v, lo, hi, why) {
    if (Number.isFinite(v) && (v < lo - 1e-6 || v > hi + 1e-6))
      out.push({ ref: this.ref, pin, net, v, lo, hi, why });
  }

  // ---- programmability (UI) ----
  // If this part can have its behaviour driven in a test/UI, return a schema describing the controls;
  // null = not programmable. The driver itself is emitted by elements() from ctx.program[ref].
  programSchema() {
    return null;
  }

  // ---- helpers for subclasses ----

  val() {
    return parseVal(this.value);
  }

  byFn(re) {
    for (const p in this.pinfn) {
      if (re.test(this.pinfn[p])) return this.pins[p];
    }
    return null;
  }

  connectedPins() {
    return Object.values(this.pins);
  }

  // split a lib_id "Library:Part Name" into lowercased { cat, name }
  static lc(lib) {
    const i = (lib || '').indexOf(':');
    const cat = i < 0 ? '' : lib.slice(0, i);
    const name = i < 0 ? lib || '' : lib.slice(i + 1);
    return { cat: cat.toLowerCase(), name: name.toLowerCase() };
  }

  // the refdes class letters (e.g. "R", "LS"), with the WF26_ namespace stripped
  static refPre(ref) {
    const m = (ref || '').replace('WF26_', '').match(/^([A-Za-z]+)/);
    return m ? m[1] : '';
  }
}

// a plain 2-terminal element from `value`, skipped if the value won't parse or it isn't 2-pin
export function twoTerminal(self, type, valueOverride) {
  const v = valueOverride !== undefined ? valueOverride : self.val();
  if (v == null) return [];

  const p = self.connectedPins();
  if (p.length !== 2) return [];

  const k = Object.keys(self.pins); // pin numbers, same order as connectedPins() (for per-pad currents)
  return [{ type, a: p[0], b: p[1], value: v, ref: self.ref, pa: k[0], pb: k[1] }];
}
