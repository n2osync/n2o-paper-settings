/**
 * The settings tab, built with Obsidian's declarative settings API so every row
 * is in Obsidian's own settings search.
 *
 * Main tab: the quick layer (the theme's `quick: true` controls and its
 * presets), one page per theme section, Pictures, Your settings, N2O Sync.
 */
import {
  ConfirmationModal,
  Notice,
  Platform,
  PluginSettingTab,
  type App,
  type ButtonComponent,
  type ExtraButtonComponent,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingGroupItem,
} from 'obsidian';
import type { Control } from './parse';
import type { Look } from './looks';
import { LooksModal } from './looks-modal';
import { DEFAULT_IMAGE_TOOLS, type ImageToolSettings } from './image-tools';
import { renderSyncRow } from './n2o-sync';
import { installTheme, selectTheme, themeStatus, THEME_NAME as PAPER } from './theme-install';
import { effective, propsFor, sanitize, store } from './apply';
import type N2OPaperSettingsPlugin from './main';

/** A theme section: a level 1 heading and the groups under it. */
interface Page {
  id: string;
  title: string;
  description?: string;
  groups: { heading?: string; controls: Control[] }[];
}

const PICTURES_PAGE = 'n2o-p-pictures';
const IMAGE_KEY = 'images.';

/** Split the flat control list into pages (level 1 headings) and groups (level 2 and below). */
export function pagesOf(controls: Control[]): Page[] {
  const pages: Page[] = [];
  let page: Page | null = null;
  for (const c of controls) {
    if (c.type === 'preset-list') continue;
    if (c.type === 'heading') {
      if ((c.level ?? 1) <= 1) {
        page = { id: c.id, title: c.title, description: c.description, groups: [{ controls: [] }] };
        pages.push(page);
      } else if (page) {
        page.groups.push({ heading: c.title, controls: [] });
      }
      continue;
    }
    if (!page) {
      page = { id: 'other', title: 'Other', groups: [{ controls: [] }] };
      pages.push(page);
    }
    page.groups[page.groups.length - 1].controls.push(c);
  }
  for (const p of pages) p.groups = p.groups.filter((g) => g.controls.length);
  return pages;
}

/** The unit shown after a number: the theme's `unit`, else the CSS unit it appends. */
function unitOf(c: Control): string {
  if (c.unit) return c.unit;
  return c.format && /^(px|em|rem|%|ch|vw|vh|s|ms|deg)$/.test(c.format) ? c.format : '';
}

const PAGE_GROUPS = ['Colour and paper', 'Text', 'Blocks', 'Window and the rest'];

/** Which heading a page sits under on the main tab, by its id (both the new and the older theme ids). */
function pageGroup(id: string): string {
  if (/colou?r|paper|page|general/.test(id)) return 'Colour and paper';
  if (/text|heading/.test(id)) return 'Text';
  if (/callout|list|table|code|picture/.test(id)) return 'Blocks';
  return 'Window and the rest';
}

/** Point Obsidian's notices and modals at the window this element lives in. */
function useWindowOf(el: HTMLElement): void {
  window.activeWindow = el.win;
  window.activeDocument = el.doc;
}

export class N2OPaperSettingsTab extends PluginSettingTab {
  private plugin: N2OPaperSettingsPlugin;
  /** Live colour swatches, refreshed when a class control changes what they resolve to. */
  private swatches = new Set<() => void>();
  /** Preset dropdowns on screen, refreshed after any change. */
  private presetViews = new Set<() => void>();

  constructor(app: App, plugin: N2OPaperSettingsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = 'palette';
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { controls } = this.plugin.spec;
    const items: SettingDefinitionItem[] = [...this.notices()];
    const pictures = (): SettingDefinitionPage => ({
      type: 'page', name: 'Pictures', desc: 'The right-click menu on pictures.', items: this.pictureGroups(),
    });

    if (controls.length && themeStatus(this.app) === 'active') {
      items.push(...this.quickRows(controls));
      const pages = pagesOf(controls);
      const groups = new Map<string, SettingGroupItem[]>(PAGE_GROUPS.map((g) => [g, []]));
      for (const p of pages) groups.get(pageGroup(p.id))?.push(this.pageDef(p));
      if (!pages.some((p) => p.id === PICTURES_PAGE)) groups.get('Blocks')?.push(pictures());
      for (const [heading, rows] of groups) if (rows.length) items.push({ type: 'group', heading, items: rows });
      items.push(this.yourSettings());
    } else {
      items.push(pictures());
    }

    items.push({
      name: 'N2O Sync',
      aliases: ['notion', 'sync'],
      render: (setting) => renderSyncRow(this.app, setting, () => this.update()),
    });
    return items;
  }

  getControlValue(key: string): unknown {
    if (!key.startsWith(IMAGE_KEY)) return undefined;
    return this.plugin.images[key.slice(IMAGE_KEY.length) as keyof ImageToolSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!key.startsWith(IMAGE_KEY)) return;
    (this.plugin.images as unknown as Record<string, unknown>)[key.slice(IMAGE_KEY.length)] = value;
    await this.plugin.persist();
  }

  /** Rows that say why nothing is reaching the page, or that the theme is missing. */
  private notices(): SettingDefinition[] {
    const out: SettingDefinition[] = [];
    const { problems, controls } = this.plugin.spec;
    const status = themeStatus(this.app);

    if (status !== 'active' || !controls.length) {
      out.push({
        name: `Use ${PAPER}`,
        aliases: ['theme', 'install'],
        render: (setting) => this.renderThemeRow(setting, status, controls.length > 0),
      });
    } else if (this.plugin.lightOnlyInDark()) {
      out.push({
        name: 'Dark mode',
        desc: `${PAPER} is a light theme. In dark mode Obsidian's own look shows and nothing here is applied; your values are kept.`,
        searchable: false,
        render: (setting) => { setting.settingEl.addClass('n2o-ps-notice'); },
      });
    }
    if (problems.length) {
      out.push({
        name: `${problems.length} control(s) in the theme could not be read`,
        desc: problems.join('; '),
        searchable: false,
        render: (setting) => { setting.settingEl.addClass('n2o-ps-notice'); },
      });
    }
    return out;
  }

  private renderThemeRow(setting: Setting, status: ReturnType<typeof themeStatus>, readable: boolean): void {
    if (status === 'installed') {
      setting.setDesc(`Another theme is active. These settings paint ${PAPER} only; your values are kept.`);
      setting.addButton((b) => b.setButtonText(`Use ${PAPER}`).setCta().onClick(() => {
        useWindowOf(b.buttonEl);
        selectTheme(this.app);
      }));
      return;
    }
    setting.setDesc(status === 'active' && !readable
      ? `${PAPER} is selected, but its theme.css cannot be read, so there are no controls to show.`
      : 'These controls come from the theme, which is not in this vault yet.');
    setting.addButton((b) => b.setButtonText(`Install ${PAPER}`).setCta().onClick(() => void this.install(setting, b)));
  }

  private async install(setting: Setting, b: ButtonComponent): Promise<void> {
    b.setDisabled(true);
    try {
      await installTheme(this.app, (m) => { setting.setDesc(m); });
    } catch (e) {
      setting.setDesc(e instanceof Error ? e.message : String(e));
      b.setDisabled(false).setButtonText('Try again');
      return;
    }
    await this.plugin.readTheme();
    this.update();
  }

  /** The look row, the save row, then every `quick: true` control, ordered by `quick-order`. */
  private quickRows(controls: Control[]): SettingDefinition[] {
    const quick = controls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.quick && c.type !== 'preset-list' && c.type !== 'heading')
      .sort((a, b) => (a.c.quickOrder ?? Infinity) - (b.c.quickOrder ?? Infinity) || a.i - b.i)
      .map(({ c }) => c);
    return [this.lookRow(controls), this.saveLookRow(), ...quick.map((c) => this.row(c, true))];
  }

  private lookRow(controls: Control[]): SettingDefinition {
    const list = controls.find((c) => c.type === 'preset-list');
    return {
      name: list?.title ?? 'Preset',
      desc: 'Built-in presets set only the quick choices here and keep what you tuned on the pages; reads Custom once one differs.',
      aliases: [...(list?.aliases ?? []), 'look'],
      render: (setting) => {
        let cleanup: (() => void) | undefined;
        setting.addDropdown((d) => {
          const looks = this.plugin.looks();
          looks.forEach((l, i) => { d.addOption(String(i), l.builtIn ? l.title : `${l.title} (saved)`); });
          d.addOption('custom', 'Custom');
          const show = (): void => {
            const now = this.plugin.lookInForce();
            const at = looks.findIndex((l) => l.id === now?.id && l.builtIn === now.builtIn);
            d.setValue(at < 0 ? 'custom' : String(at));
          };
          show();
          d.onChange((v) => {
            const look = looks[Number(v)];
            if (v !== 'custom' && look) void this.plugin.applyLook(look);
            else show();
          });
          this.presetViews.add(show);
          cleanup = () => this.presetViews.delete(show);
        });
        return cleanup;
      },
    };
  }

  private saveLookRow(): SettingDefinition {
    return {
      name: 'Save current look...',
      desc: 'Keep everything you have changed as a look you can pick above. Rename or delete saved looks here too.',
      aliases: ['preset', 'look', 'save'],
      render: (setting) => void setting.addButton((b) => b.setButtonText('Your looks...').onClick(() => {
        useWindowOf(b.buttonEl);
        new LooksModal(this.plugin, () => this.update()).open();
      })),
    };
  }

  private pageDef(p: Page): SettingDefinitionPage {
    const ids = new Set(p.groups.flatMap((g) => g.controls.map((c) => c.id)));
    const items: SettingDefinitionItem[] = [];
    for (const g of p.groups) {
      const rows: SettingGroupItem[] = g.controls.map((c) => this.row(c, false));
      if (g.heading) items.push({ type: 'group', heading: g.heading, items: rows });
      else items.push(...rows);
    }
    if (p.id === PICTURES_PAGE) items.push(...this.pictureGroups());
    return {
      type: 'page',
      name: p.title,
      desc: p.description,
      displayValue: () => {
        const n = Object.keys(this.plugin.values).filter((k) => ids.has(k)).length;
        return n ? `${n} changed` : '';
      },
      items,
    };
  }

  /** One theme control. Quick-layer copies are searchable; their page copies are not, so search lists each once. */
  private row(c: Control, quick: boolean): SettingDefinition {
    const dep = c.depends;
    const unit = unitOf(c);
    return {
      name: unit && c.type.startsWith('variable-number') ? `${c.title} (${unit})` : c.title,
      desc: c.description,
      aliases: c.aliases,
      searchable: quick || !c.quick,
      visible: dep ? () => this.plugin.values[dep] === true : undefined,
      render: (setting) => this.renderControl(setting, c),
    };
  }

  private renderControl(setting: Setting, c: Control): (() => void) | void {
    const p = this.plugin;
    const current = effective(c, p.values, false);
    let resetBtn: ExtraButtonComponent | null = null;
    let cleanup: (() => void) | undefined;

    const set = async (value: string | number | boolean | undefined) => {
      store(p.values, c, value);
      resetBtn?.setDisabled(p.values[c.id] === undefined);
      await p.persist();
      if (p.spec.controls.some((k) => k.depends === c.id)) this.refreshDomState();
      this.presetViews.forEach((f) => f());
    };

    setting.addExtraButton((b) => {
      resetBtn = b.setIcon('rotate-ccw').setTooltip('Restore default').onClick(() => {
        void set(undefined).then(() => this.update());
      });
      b.setDisabled(p.values[c.id] === undefined);
    });

    switch (c.type) {
      case 'class-toggle':
        setting.addToggle((t) => t.setValue(current === true).onChange((v) => void set(v || undefined)));
        break;

      case 'class-select':
      case 'variable-select':
        setting.addDropdown((d) => {
          for (const o of c.options) d.addOption(o, c.labels?.[o] ?? optionLabel(o, c.options));
          d.setValue(String(current ?? c.options[0] ?? ''));
          d.onChange((v) => void set(v).then(() => this.swatches.forEach((f) => f())));
        });
        break;

      case 'variable-number-slider':
        setting.addSlider((s) => s
          .setLimits(c.min ?? 0, c.max ?? 100, c.step ?? 1)
          .setValue(Number(current ?? 0))
          .onChange((v) => void set(v)));
        break;

      case 'variable-number':
        setting.addText((t) => {
          t.setPlaceholder(c.default ?? c.placeholder ?? '')
            .setValue(p.values[c.id] === undefined ? '' : String(p.values[c.id]))
            .onChange((v) => {
              if (v.trim() === '') return void set(undefined);
              const n = Number(v);
              if (Number.isFinite(n)) void set(n);
            });
          t.inputEl.addClass('n2o-ps-number');
        });
        break;

      case 'variable-color':
      case 'variable-themed-color': {
        // Until the user picks one, the swatch shows what the page is painting:
        // a palette changes what most colours resolve to.
        const props = propsFor(c);
        const live = () => (p.values[c.id] === undefined && props.length === 1 ? liveHex(props[0]) : undefined);
        // setValue fires onChange, and a refresh must not count as a pick.
        let refreshing = false;
        setting.addColorPicker((picker) => {
          picker.setValue(normaliseHex(live() ?? String(current ?? '#000000')))
            .onChange((v) => { if (!refreshing) void set(v); });
          const refresh = () => {
            const h = live();
            if (!h) return;
            refreshing = true;
            try { picker.setValue(h); } finally { refreshing = false; }
          };
          this.swatches.add(refresh);
          cleanup = () => this.swatches.delete(refresh);
        });
        break;
      }

      case 'variable-text':
      default:
        setting.addText((t) => t
          .setPlaceholder(String(c.default ?? ''))
          .setValue(p.values[c.id] === undefined ? '' : String(p.values[c.id]))
          .onChange((v) => void set(v || undefined)));
        break;
    }
    return cleanup;
  }

  /** The picture menu is this plugin's own, so its rows are declared here. */
  private pictureGroups(): SettingDefinitionItem[] {
    const mod = Platform.isMacOS ? 'Cmd' : 'Ctrl';
    const key = (k: keyof ImageToolSettings) => `${IMAGE_KEY}${k}`;
    const pics = ['picture', 'image', 'photo'];
    const toggle = (k: keyof ImageToolSettings, name: string, desc: string): SettingDefinition => ({
      name, desc, aliases: pics,
      control: { type: 'toggle', key: key(k), defaultValue: DEFAULT_IMAGE_TOOLS[k] as boolean },
    });
    return [
      {
        type: 'group',
        heading: 'Right-click menu',
        items: [
          {
            name: 'Sizes offered',
            desc: 'Comma separated. 50% halves the current width; 600px sets a fixed width.',
            aliases: [...pics, 'resize', 'width'],
            control: { type: 'text', key: key('customSizes'), defaultValue: DEFAULT_IMAGE_TOOLS.customSizes },
          },
          {
            name: `${mod} click`,
            desc: `What clicking a picture with ${mod} held does.`,
            aliases: pics,
            control: {
              type: 'dropdown',
              key: key('clickAction'),
              defaultValue: DEFAULT_IMAGE_TOOLS.clickAction,
              options: { nothing: 'Do nothing', 'new-tab': 'Open in a new tab', 'default-app': 'Open in the default app' },
            },
          },
          toggle('confirmDelete', 'Ask before deleting', 'Confirm before a picture goes to the trash.'),
          toggle('wheelResize', 'Resize with the wheel', 'Scroll over a picture with the modifier held to resize it.'),
          {
            name: 'Wheel modifier',
            desc: 'The key held while scrolling to resize.',
            aliases: pics,
            control: {
              type: 'dropdown',
              key: key('wheelModifier'),
              defaultValue: DEFAULT_IMAGE_TOOLS.wheelModifier,
              options: { alt: 'Alt', ctrl: mod, shift: 'Shift' },
            },
          },
          {
            name: 'Wheel step',
            desc: 'How much one notch changes the width, as a percent of the current width.',
            aliases: pics,
            control: {
              type: 'slider', key: key('wheelStep'), min: 1, max: 50, step: 1,
              defaultValue: DEFAULT_IMAGE_TOOLS.wheelStep, displayFormat: (v) => `${v}%`,
            },
          },
          toggle('wheelInvert', 'Invert wheel direction', 'Scroll down to enlarge instead of up.'),
        ],
      },
      {
        type: 'group',
        heading: 'Rows in the menu',
        items: [
          toggle('showFileInfo', 'File name and size', 'A label with the file name and its pixel size.'),
          toggle('showCopyImage', 'Copy image', 'Copy the picture to the clipboard.'),
          toggle('showCopyPath', 'Copy local path', 'Copy the full path on disk.'),
          toggle('showOpenInNewTab', 'Open in new tab', 'Open the picture file in a new tab.'),
          toggle('showOpenToRight', 'Open to the right', 'Open the picture file in a split.'),
          toggle('showOpenInNewWindow', 'Open in new window', 'Open the picture file in a new window.'),
          toggle('showOpenInDefaultApp', 'Open in default app', 'Open the file in the app your system uses for it.'),
          toggle('showInSystemExplorer', 'Show in the file manager', 'Reveal the file in your system file manager.'),
          toggle('showRename', 'Rename image', 'Rename the file and update the notes that link to it.'),
          toggle('showDelete', 'Delete image and link', 'Remove the embed and trash the file if nothing else uses it.'),
        ],
      },
    ];
  }

  private yourSettings(): SettingDefinitionItem {
    const p = this.plugin;
    return {
      type: 'group',
      heading: 'Your settings',
      items: [
        {
          name: 'Export',
          desc: 'Copy the values you have changed, and your saved looks, to the clipboard.',
          aliases: ['backup'],
          render: (setting) => void setting.addButton((b) => b.setButtonText('Export').onClick(async () => {
            useWindowOf(b.buttonEl);
            try {
              await navigator.clipboard.writeText(JSON.stringify({ values: p.values, looks: p.savedLooks }, null, 2));
              new Notice(`Copied ${Object.keys(p.values).length} changed value(s) and ${p.savedLooks.length} look(s) to the clipboard.`);
            } catch {
              new Notice('Could not write to the clipboard. Your settings are unchanged.');
            }
          })),
        },
        {
          name: 'Import',
          desc: 'Read an export from the clipboard, then merge it with your values or replace them.',
          aliases: ['backup'],
          render: (setting) => void setting.addButton((b) => b.setButtonText('Import').onClick(() => void this.importFromClipboard(b))),
        },
        {
          name: 'Reset all',
          desc: 'Put every control back to the theme default.',
          aliases: ['restore defaults'],
          render: (setting) => void setting.setClass('n2o-ps-danger').addButton((b) => b.setButtonText('Reset all').setDestructive().onClick(() => {
            useWindowOf(b.buttonEl);
            const count = Object.keys(p.values).length;
            if (!count) {
              new Notice('Nothing to reset, everything is already at the theme default.');
              return;
            }
            const modal = new ConfirmationModal(this.app).addClass('n2o-ps-modal');
            modal.setTitle('Reset all?');
            modal.setContent(`Reset all ${count} changed value(s) to the ${PAPER} defaults? Your saved looks and the picture menu settings are kept.`);
            modal.addButton((btn) => btn.setButtonText('Cancel').setCancel().setInitialFocus());
            modal.addButton((btn) => btn.setButtonText('Reset all').setDestructive().setCta().onClick(async () => {
              p.values = {};
              await p.persist();
              this.update();
              new Notice('Reset to theme defaults.');
            }));
            modal.open();
          })),
        },
      ],
    };
  }

  private async importFromClipboard(b: ButtonComponent): Promise<void> {
    useWindowOf(b.buttonEl);
    const p = this.plugin;
    let raw: unknown;
    try {
      raw = JSON.parse(await navigator.clipboard.readText());
    } catch {
      new Notice(`Could not read an ${PAPER} export from the clipboard. Nothing was changed.`);
      return;
    }
    // Current exports are { values, looks }; older ones are the values alone.
    const wrapped = typeof raw === 'object' && raw !== null && 'values' in raw ? raw as { values?: unknown; looks?: unknown } : null;
    const result = sanitize(p.spec.controls, wrapped ? wrapped.values : raw);
    const looks = Array.isArray(wrapped?.looks) ? (wrapped.looks as Look[]).filter((l) => l && typeof l.title === 'string' && typeof l.values === 'object') : [];
    if (!result || (!Object.keys(result.values).length && !looks.length)) {
      new Notice(`No ${PAPER} settings in that clipboard content. Nothing was changed.`);
      return;
    }

    const n = Object.keys(result.values).length;
    const ignored = result.dropped ? ` Ignored ${result.dropped} this theme does not have.` : '';
    const finish = async (merge: boolean) => {
      p.values = merge ? { ...p.values, ...result.values } : result.values;
      const incoming = looks.map((l) => ({ id: String(l.id ?? `look-${Date.now()}`), title: l.title, values: l.values, builtIn: false }));
      p.savedLooks = merge
        ? [...p.savedLooks.filter((l) => !incoming.some((x) => x.id === l.id)), ...incoming]
        : incoming;
      await p.persist();
      this.update();
      new Notice(`Imported ${n} value(s) and ${incoming.length} look(s).${ignored}`);
    };

    if (!Object.keys(p.values).length && !p.savedLooks.length) {
      await finish(false);
      return;
    }
    const modal = new ConfirmationModal(this.app).addClass('n2o-ps-modal');
    modal.setTitle('Import');
    modal.setContent(`The file has ${n} value(s) and ${looks.length} look(s). Merge keeps your other values and looks; Replace resets everything the file does not have.`);
    modal.addCancelButton();
    modal.addButton((btn) => btn.setButtonText('Replace').setDestructive().onClick(() => finish(false)));
    modal.addButton((btn) => btn.setButtonText('Merge').setCta().setInitialFocus().onClick(() => finish(true)));
    modal.open();
  }
}

/** Names that capitalise in a way no rule can guess. */
const SPECIAL_LABELS: Record<string, string> = {
  ibm: 'IBM Plex',
  fira: 'Fira Code',
  'iawriter-quattro': 'iA Writer Quattro',
  inter: 'Inter',
  light: 'Paper',
  contrast: 'High contrast',
  'warm-dark': 'Warm dark',
  default: 'Default',
};

/** A dropdown label from an option value: the prefix the options share is dropped, `n2o-headings-medium` reads `Medium`. */
export function optionLabel(option: string, siblings: string[]): string {
  let prefix = '';
  if (siblings.length > 1) {
    const parts = siblings.map((s) => s.split('-'));
    const first = parts[0];
    let i = 0;
    while (i < first.length && parts.every((p) => p[i] === first[i])) i++;
    prefix = first.slice(0, i).join('-');
  }
  const bare = prefix && option.startsWith(prefix)
    ? option.slice(prefix.length).replace(/^-/, '')
    : option.replace(/^n2o-/, '');

  if (SPECIAL_LABELS[bare]) return SPECIAL_LABELS[bare];
  const words = bare.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the page paints for a custom property right now, as #rrggbb. */
function liveHex(prop: string): string | undefined {
  const raw = getComputedStyle(document.body).getPropertyValue(prop).trim();
  if (!raw) return undefined;
  const probe = document.body.createSpan();
  probe.setCssProps({ color: raw });
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = rgb.match(/\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return undefined;
  return '#' + m.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('');
}

/** Obsidian's colour picker wants #rrggbb and nothing else. */
function normaliseHex(v: string): string {
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) return '#' + t.slice(1).split('').map((c) => c + c).join('');
  return '#000000';
}
