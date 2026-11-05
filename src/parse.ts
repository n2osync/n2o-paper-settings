/**
 * Read the control list out of N2O Paper's theme.css.
 *
 * The theme's `@settings` block is the single source of truth: a control added
 * there appears in the settings tab with no code change here.
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
  | 'class-select'
  | 'preset-list';

export interface Preset {
  id: string;
  title: string;
  values: Record<string, string | number | boolean>;
}

export interface Control {
  id: string;
  title: string;
  description?: string;
  type: ControlType;
  level?: number;
  format?: string;
  /** Shown after a number field: px, em, %, rem. */
  unit?: string;
  /** Extra words Obsidian's settings search matches. */
  aliases?: string[];
  /** Id of a class-toggle; this control shows only while that toggle is on. */
  depends?: string;
  /** Also shown in the quick layer at the top of the tab. */
  quick?: boolean;
  quickOrder?: number;
  /** Hint shown in an empty number field when the control has no default. */
  placeholder?: string;
  /** Values the cycle command steps through; null clears the value. */
  cycle?: (number | null)[];
  default?: string;
  defaultLight?: string;
  defaultDark?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Option values, in order. */
  options: string[];
  /** Option labels the theme spelled out, keyed by value. */
  labels?: Record<string, string>;
  presets?: Preset[];
}

export interface ParseResult {
  name: string;
  id: string;
  controls: Control[];
  /** Entries that could not be read, shown in the tab rather than dropped. */
  problems: string[];
}

const EMPTY = (problem: string): ParseResult => ({ name: '', id: '', controls: [], problems: [problem] });

/**
 * Parse the block with `yaml` (Obsidian's parseYaml in the app). A block that
 * is not valid YAML goes through the line reader instead, which understands the
 * flat shape older theme releases shipped.
 */
export function parseSettingsBlock(css: string, yaml?: (text: string) => unknown): ParseResult {
  const start = css.indexOf('/* @settings');
  if (start < 0) return EMPTY('no @settings block in theme.css');
  const block = css.slice(start + '/* @settings'.length, css.indexOf('*/', start));

  if (yaml) {
    try {
      const doc = yaml(block) as { name?: unknown; id?: unknown; settings?: unknown } | null;
      if (doc && Array.isArray(doc.settings)) {
        const problems: string[] = [];
        const controls: Control[] = [];
        for (const raw of doc.settings as unknown[]) {
          const c = toControl(raw, problems);
          if (c) controls.push(c);
        }
        return { name: str(doc.name) ?? '', id: str(doc.id) ?? '', controls, problems };
      }
    } catch {
      /* not valid YAML: an older theme release, read line by line below */
    }
  }
  return parseLines(block);
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toControl(raw: unknown, problems: string[]): Control | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const id = str(f.id);
  const type = str(f.type);
  if (!id || !type) {
    problems.push(`entry with no ${!id ? 'id' : 'type'}: ${JSON.stringify(f).slice(0, 80)}`);
    return null;
  }

  const options: string[] = [];
  const labels: Record<string, string> = {};
  if (Array.isArray(f.options)) {
    for (const o of f.options as unknown[]) {
      if (typeof o === 'object' && o !== null) {
        const value = str((o as Record<string, unknown>).value);
        if (value === undefined) continue;
        options.push(value);
        const label = str((o as Record<string, unknown>).label);
        if (label) labels[value] = label;
      } else {
        const value = str(o);
        if (value !== undefined) options.push(value);
      }
    }
  }

  const c: Control = { id, title: str(f.title) ?? id, type: type as ControlType, options };
  c.description = str(f.description);
  c.level = num(f.level);
  c.format = str(f.format);
  c.unit = str(f.unit);
  c.depends = str(f.depends) ?? str(f.showWhen);
  c.quick = f.quick === true;
  c.quickOrder = num(f['quick-order']);
  c.placeholder = str(f.placeholder);
  if (Array.isArray(f.cycle)) c.cycle = (f.cycle as unknown[]).map((v) => (v === 'unset' ? null : num(v))).filter((v): v is number | null => v !== undefined);
  c.default = str(f.default);
  c.defaultLight = str(f['default-light']);
  c.defaultDark = str(f['default-dark']);
  c.min = num(f.min);
  c.max = num(f.max);
  c.step = num(f.step);
  if (Array.isArray(f.aliases)) c.aliases = (f.aliases as unknown[]).map(str).filter((a): a is string => !!a);
  if (Object.keys(labels).length) c.labels = labels;
  if (Array.isArray(f.presets)) c.presets = (f.presets as unknown[]).map(toPreset).filter((p): p is Preset => !!p);
  return c;
}

function toPreset(raw: unknown): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id || typeof p.values !== 'object' || p.values === null) return null;
  const values: Preset['values'] = {};
  for (const [k, v] of Object.entries(p.values as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
  }
  return { id, title: str(p.title) ?? id, values };
}

/** The line reader for blocks that are not valid YAML. Flat keys and string lists only. */
function parseLines(block: string): ParseResult {
  const raws: Record<string, unknown>[] = [];
  let name = '';
  let id = '';
  let current: Record<string, unknown> | null = null;
  let list: string[] | null = null;

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*-\s*$/.test(line)) {
      current = {};
      raws.push(current);
      list = null;
      continue;
    }
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (current && list && item) {
      list.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kv = /^\s*([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (!current) {
      if (kv[1] === 'name') name = value;
      if (kv[1] === 'id') id = value;
      continue;
    }
    if (value === '' && (kv[1] === 'options' || kv[1] === 'aliases')) {
      list = [];
      current[kv[1]] = list;
      continue;
    }
    list = null;
    current[kv[1]] = kv[1] === 'quick' ? value === 'true' : value;
  }

  const problems: string[] = [];
  const controls = raws.map((r) => toControl(r, problems)).filter((c): c is Control => !!c);
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
