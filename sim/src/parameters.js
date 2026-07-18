// Strict per-component simulation parameter overrides.
//
// Corner tests address the live schematic by reference (R25, C20, Q4, ...). Every requested
// override must be consumed by that component's model; a misspelled reference or parameter is an
// error rather than a nominal-looking simulation that silently ignored the intended corner.

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export class ParameterOverrides {
  constructor(overrides = {}, componentRefs = []) {
    if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides))
      throw new TypeError('simulation params must be an object keyed by component reference');

    this.overrides = overrides;
    this.refs = new Set(componentRefs);
    this.used = new Map();
    this.resolved = {};

    for (const [ref, values] of Object.entries(overrides)) {
      if (!this.refs.has(ref)) throw new Error(`simulation params reference unknown component ${ref}`);
      if (values == null || typeof values !== 'object' || Array.isArray(values))
        throw new TypeError(`simulation params for ${ref} must be an object`);
      this.used.set(ref, new Set());
    }
  }

  get(ref, name, nominal) {
    const values = this.overrides[ref];
    const overridden = values != null && own(values, name);
    const value = overridden ? values[name] : nominal;
    if (overridden) {
      if (value === undefined) throw new Error(`simulation parameter ${ref}.${name} is undefined`);
      this.used.get(ref).add(name);
      (this.resolved[ref] ||= {})[name] = { nominal, value };
    }
    return value;
  }

  assertConsumed() {
    const unused = [];
    for (const [ref, values] of Object.entries(this.overrides)) {
      const used = this.used.get(ref);
      for (const name of Object.keys(values)) if (!used.has(name)) unused.push(`${ref}.${name}`);
    }
    if (unused.length)
      throw new Error(`unused simulation parameter override(s): ${unused.sort().join(', ')}`);
  }

  snapshot() {
    return structuredClone(this.resolved);
  }
}

export function diodeIsAt(vf, current, n = 1, temperatureV = 0.025852) {
  if (!(vf > 0) || !(current > 0) || !(n > 0))
    throw new RangeError('diodeIsAt requires positive vf, current and ideality factor');
  return current / Math.expm1(vf / (n * temperatureV));
}
