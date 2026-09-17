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
