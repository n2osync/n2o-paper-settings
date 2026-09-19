/**
 * Put the user's choices onto the page, and take them off again cleanly.
 *
 * Two lessons taken from Minimal Theme Settings:
 *
 *   Inline properties, not an injected stylesheet. body.setCssProps() writes
 *   inline styles, which beat every selector in the theme without a specificity
 *   war and without a <style> element to keep in the right document order. Style
 *   Settings takes the other route and has to add a body class purely so its
 *   rules can outrank the theme's.
 *
 *   Remove everything on unload. Classes and properties left behind after
 *   being disabled look like the next theme's bugs.
 *
 * Where this improves on Minimal: it maintains hand-written arrays of every
 * class to remove. Ours are derived from the parsed controls, so teardown
 * cannot fall out of step with what was applied.
 */
import type { Control } from './parse';
import { hexToHsl } from './parse';

export type Values = Record<string, string | number | boolean>;

/** Every CSS custom property a given control writes. */
export function propsFor(c: Control): string[] {
  if (!c.type.startsWith('variable-')) return [];
  if (c.type === 'variable-color' && c.format === 'hsl-split') {
    return [`--${c.id}-h`, `--${c.id}-s`, `--${c.id}-l`];
  }
  return [`--${c.id}`];
}

/** Every body class a given control can add. */
export function classesFor(c: Control): string[] {
  if (c.type === 'class-toggle') return [c.id];
  if (c.type === 'class-select') return c.options;
  return [];
}

/** The value in force for a control: what the user chose, else the theme's own default. */
export function effective(c: Control, values: Values, isDark: boolean): string | number | boolean | undefined {
  const chosen = values[c.id];
  if (chosen !== undefined && chosen !== '') return chosen;
  if (c.type === 'variable-themed-color') return isDark ? c.defaultDark : c.defaultLight;
  // The YAML gives a toggle's default as text. Everything downstream
  // compares against a real boolean, so it becomes one here and nowhere else.
  if (c.type === 'class-toggle') return c.default === 'true';
  return c.default;
}

/**
 * Apply everything. Called on load, on any change, and again whenever Obsidian
 * reports a css-change, because switching light and dark alters which half of
 * every themed colour is in force.
 */
export function apply(controls: Control[], values: Values): void {
  const body = document.body;
  const isDark = body.classList.contains('theme-dark');

  // Start from a clean slate so a control that was just cleared really clears.
  reset(controls);

  const props: Record<string, string> = {};

  for (const c of controls) {
    if (c.type === 'heading') continue;

    // ONLY what the user actually changed. Writing the theme's own defaults
    // back as inline styles looks harmless and is not: an inline value beats
    // every rule in the stylesheet, so it freezes out the theme's own
    // conditional rules. Writing the default 0.95rem for
    // --font-paragraph defeated the smaller size the theme sets
    // for its compact-interface mode, and did the same to every themed
    // colour's light and dark halves. The theme should govern until the user
    // overrides it, and not one property before.
    if (values[c.id] === undefined || values[c.id] === '') continue;
    const v = effective(c, values, isDark);

    if (c.type === 'class-toggle') {
      if (v === true) body.classList.add(c.id);
      continue;
    }

    if (c.type === 'class-select') {
      if (typeof v === 'string' && v) body.classList.add(v);
      continue;
    }

    if (v === undefined || v === '') continue;

    if (c.type === 'variable-color' && c.format === 'hsl-split') {
      const hsl = hexToHsl(String(v));
      if (!hsl) continue;
      props[`--${c.id}-h`] = String(hsl.h);
      props[`--${c.id}-s`] = `${hsl.s}%`;
      props[`--${c.id}-l`] = `${hsl.l}%`;
      continue;
    }

    props[`--${c.id}`] = c.format && c.format !== 'hex' && typeof v !== 'boolean'
      ? `${v}${c.format}`
      : String(v);
  }

  body.setCssProps(props);
}

/** Remove every property and class this plugin is capable of setting. */
export function reset(controls: Control[]): void {
  const body = document.body;
  for (const c of controls) {
    for (const p of propsFor(c)) body.style.removeProperty(p);
    for (const cls of classesFor(c)) body.classList.remove(cls);
  }
}

/**
 * Keep only what THIS theme can actually use, and say what was thrown away.
 *
 * Import used to accept any non-null non-array object, assign it, and persist
 * it, and only then apply it. Three things went wrong at once:
 *
 *   - `{}` or a copied package.json passed, wiping every setting, and the
 *     notice said "Imported 0 setting(s)" as though it had worked.
 *   - a value carrying a space reached `body.classList.add`, which throws
 *     InvalidCharacterError. The catch reported "not an N2O Paper export",
 *     by which time data.json had ALREADY been overwritten: the old config
 *     was gone and the message said nothing had happened.
 *   - a select value from an older theme version was applied but could never
 *     be removed, because reset() only knows the options the theme declares
 *     today.
 *
 * Validating against the control list fixes all three, and it identifies an
 * export better than a marker would: a file whose keys are this theme's
 * control ids IS one, whatever it claims about itself.
 *
 * Returns null when the input is not an object at all. Pure, and tested.
 */
export function sanitize(controls: Control[], raw: unknown): { values: Values; dropped: number } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const byId = new Map(controls.filter((c) => c.type !== 'heading').map((c) => [c.id, c]));
  const values: Values = {};
  let dropped = 0;

  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = byId.get(key);
    const kept = c ? fits(c, v) : undefined;
    if (kept === undefined) { dropped++; continue; }
    values[key] = kept;
  }
  return { values, dropped };
}

/** The value this control would accept, or undefined to drop it. */
function fits(c: Control, v: unknown): string | number | boolean | undefined {
  switch (c.type) {
    case 'class-toggle':
      // Only `true` is ever stored; false means "left at the default", and a
      // string "true" is not a toggle, it is a mistake that renders as one.
      return v === true ? true : undefined;
    case 'class-select':
    case 'variable-select':
      return typeof v === 'string' && c.options.includes(v) ? v : undefined;
    case 'variable-number':
    case 'variable-number-slider':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    default:
      // text and colours. A number is allowed: the UI writes one for sizes.
      return typeof v === 'string' || typeof v === 'number' ? v : undefined;
  }
}
