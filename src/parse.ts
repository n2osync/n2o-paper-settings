/**
 * Read the control list out of N2O Paper's own theme.css.
 *
 * Why not a hardcoded list: Minimal Theme Settings, the plugin this one learns
 * from, declares every control in TypeScript and then maintains hand-written
 * arrays of class names to remove on teardown. That is the exclusion-list
 * pattern, and it drifts when a control is added without its removal line.
 *
 * The theme already carries a machine-readable spec of every control, because
 * the Style Settings format demands one and our own gate checks it. So the
 * theme is the single source of truth and this plugin renders whatever it
 * finds. Add a control to the theme, it appears here. Delete one, it vanishes,
 * along with whatever it had set.
 */

export type ControlType =
  | 'heading'
  | 'variable-text'
  | 'variable-number'
  | 'variable-number-slider'
  | 'variable-select'
  | 'variable-color'
  | 'variable-themed-color'
  | 'class-toggle'
  | 'class-select';

export interface Control {
  id: string;
  title: string;
  description?: string;
  type: ControlType;
  level?: number;
  format?: string;
  /** Id of a class-toggle that reveals this control. Hidden while that
   *  toggle is off, so a setting nobody has opted into cannot sit on screen
   *  looking broken. An empty text box is not a default, it is a question. */
  showWhen?: string;
  /** A word shown beside a HEADING, marking what kind of group it is
   *  ("Advanced"). The groups that carry it used to live under a separate
   *  Advanced section; folding them in made the panel one list and lost the
   *  warning, so the warning moves onto the group itself. */
  badge?: string;
  /** On a SECTION heading: its groups do not fold. For the short section a
   *  reader meets first, where a fold is one click between them and the
   *  handful of choices that change everything. */
  flat?: boolean;
  /** On a SECTION heading: draw no header at all. The section a reader
   *  lands on needs no name; it is simply what is on screen. */
  hideTitle?: boolean;
  default?: string;
  defaultLight?: string;
  defaultDark?: string;
  min?: number;
  max?: number;
  step?: number;
  options: string[];
}

export interface ParseResult {
  name: string;
  id: string;
  controls: Control[];
  /** Entries this parser could not make sense of. Surfaced in the UI rather
   *  than dropped, so a format mistake in the theme is visible immediately
   *  instead of silently costing a control. */
  problems: string[];
}

/**
 * A tolerant reader for the flavour of YAML that lives inside a CSS comment.
 *
 * Deliberately not a real YAML parser: the block is ours, its shape is fixed,
 * and a dependency that throws on a stray tab is worse than a short reader.
 */
export function parseSettingsBlock(css: string): ParseResult {
  const start = css.indexOf('/* @settings');
  if (start < 0) return { name: '', id: '', controls: [], problems: ['no @settings block in theme.css'] };
  const block = css.slice(start, css.indexOf('*/', start));

  const problems: string[] = [];
  const controls: Control[] = [];
  let name = '';
  let id = '';

  /** Fields and options are kept apart so neither needs a cast to read. */
  interface RawEntry { fields: Record<string, string>; options: string[] }
  let current: RawEntry | null = null;
  let inOptions = false;

  const flush = () => {
    if (!current) return;
    const { fields: f, options } = current;
    current = null;
    if (!f.id || !f.type) {
      problems.push(`entry with no ${!f.id ? 'id' : 'type'}: ${JSON.stringify(f).slice(0, 80)}`);
      return;
    }
    const control: Control = {
      id: f.id,
      title: f.title ?? f.id,
      description: f.description,
      type: f.type as ControlType,
      options,
    };
    if (f.level) control.level = Number(f.level);
    if (f.format) control.format = f.format;
    if (f.showWhen) control.showWhen = String(f.showWhen);
    if (f.badge) control.badge = String(f.badge);
    if (f.flat) control.flat = String(f.flat) === 'true';
    if (f.hideTitle) control.hideTitle = String(f.hideTitle) === 'true';
    if (f.default !== undefined) control.default = f.default;
    if (f['default-light'] !== undefined) control.defaultLight = f['default-light'];
    if (f['default-dark'] !== undefined) control.defaultDark = f['default-dark'];
    if (f.min !== undefined) control.min = Number(f.min);
    if (f.max !== undefined) control.max = Number(f.max);
    if (f.step !== undefined) control.step = Number(f.step);
    controls.push(control);
  };

  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');

    if (/^\s*-\s*$/.test(line)) { flush(); current = { fields: {}, options: [] }; inOptions = false; continue; }

    const opt = line.match(/^\s*-\s+(.+)$/);
    if (current && inOptions && opt) {
      current.options.push(opt[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    const kv = line.match(/^\s*([a-zA-Z-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '');

    if (!current) {
      if (key === 'name') name = value;
      if (key === 'id') id = value;
      continue;
    }
    if (key === 'options') { inOptions = true; continue; }
    inOptions = false;
    current.fields[key] = value;
  }
  flush();

  return { name, id, controls, problems };
}

/** Hex to the three HSL numbers Obsidian wants for an accent. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let raw = m[1];
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 1000) / 10 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h: Math.round(h * 10) / 10, s: Math.round(s * 1000) / 10, l: Math.round(l * 1000) / 10 };
}
