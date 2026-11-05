/**
 * Looks: the theme's built-in presets and the user's saved looks.
 *
 * A built-in look sets only the quick-layer controls it names and leaves
 * everything tuned on the pages alone. A saved look is every value the user
 * had changed, and applying it restores exactly that set.
 */
import type { Control } from './parse';
import { effective, sanitize, store, type Values } from './apply';

export interface Look {
  id: string;
  title: string;
  values: Values;
  /** True for the theme's presets, false for the user's saved looks. */
  builtIn: boolean;
}

/** The theme's presets, trimmed to the quick-layer keys. */
export function builtInLooks(controls: Control[]): Look[] {
  const quick = new Set(controls.filter((c) => c.quick).map((c) => c.id));
  const list = controls.find((c) => c.type === 'preset-list' && c.presets?.length);
  return (list?.presets ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    builtIn: true,
    values: Object.fromEntries(Object.entries(p.values).filter(([k]) => quick.has(k))),
  }));
}

/** Is this look what is on screen? Built-in: its keys match. Saved: the stored values are exactly its values. */
export function lookMatches(controls: Control[], values: Values, look: Look): boolean {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const same = (k: string, v: unknown) => {
    const c = byId.get(k);
    return !c || String(effective(c, values, false)) === String(v);
  };
  if (look.builtIn) return Object.entries(look.values).every(([k, v]) => same(k, v));
  const keys = Object.keys(values);
  return keys.length === Object.keys(look.values).length && keys.every((k) => k in look.values && same(k, look.values[k]));
}

/** The values after applying a look. */
export function withLook(controls: Control[], values: Values, look: Look): Values {
  const next: Values = look.builtIn ? { ...values } : {};
  const ok = sanitize(controls, look.values)?.values ?? {};
  for (const [k, v] of Object.entries(look.values)) {
    const c = controls.find((x) => x.id === k);
    if (c?.type === 'class-toggle') store(next, c, v === true);
    else if (c && k in ok) store(next, c, v);
  }
  return next;
}
