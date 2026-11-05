/**
 * Put the user's choices onto the page and take them off again.
 *
 * Values go on body as inline custom properties and classes, and only the ones
 * the user changed: an inline default would beat the theme's own conditional
 * rules. Teardown is derived from the parsed controls, so it removes exactly
 * what apply() can add.
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
  if (c.type === 'class-toggle') return c.default === 'true';
  return c.default;
}

/** The theme's own default for a control, as the value the UI would store. */
export function defaultOf(c: Control): string | number | boolean | undefined {
  if (c.type === 'class-toggle') return false;
  if (c.type === 'variable-themed-color') return c.defaultLight ?? c.default;
  if (c.type === 'variable-number' || c.type === 'variable-number-slider') {
    return c.default === undefined ? undefined : Number(c.default);
  }
  return c.default;
}

/** Store a value, or drop it when it is empty or equal to the theme default. */
export function store(values: Values, c: Control, v: string | number | boolean | undefined): void {
  const def = defaultOf(c);
  if (v === undefined || v === '' || (def !== undefined && String(v).toLowerCase() === String(def).toLowerCase())) {
    delete values[c.id];
  } else {
    values[c.id] = v;
  }
}

/** Apply every changed value. Runs on load, on any change, and on css-change. */
export function apply(controls: Control[], values: Values): void {
  const body = document.body;
  const isDark = body.classList.contains('theme-dark');

  reset(controls);

  const props: Record<string, string> = {};

  for (const c of controls) {
    if (c.type === 'heading') continue;

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
 * Keep only values this theme's controls accept: known ids, valid options,
 * finite numbers. Returns null when the input is not an object at all.
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
      // Only `true` is stored; false means "left at the default".
      return v === true ? true : undefined;
    case 'class-select':
    case 'variable-select':
      return typeof v === 'string' && c.options.includes(v) ? v : undefined;
    case 'variable-number':
    case 'variable-number-slider':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    case 'preset-list':
      return undefined;
    default:
      // Text and colours. A number is allowed: the UI writes one for sizes.
      return typeof v === 'string' || typeof v === 'number' ? v : undefined;
  }
}
