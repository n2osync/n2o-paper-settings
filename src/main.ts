/**
 * N2O Settings: renders the controls N2O Paper declares in its theme.css,
 * applies the values while N2O Paper is the active light theme, and adds the
 * picture menu, the commands and a status-bar menu.
 */
import { Menu, Notice, Plugin, parseYaml, setIcon } from 'obsidian';
import { parseSettingsBlock, type Control, type ParseResult } from './parse';
import { apply, effective, reset, store, type Values } from './apply';
import { builtInLooks, lookMatches, withLook, type Look } from './looks';
import { lookActions, type Action } from './actions';
import { N2OPaperSettingsTab, optionLabel } from './settings-tab';
import { registerPictureCaptions } from './picture-captions';
import { registerImageMenu, flagRowsFor } from './image-menu';
import { registerImageTools, DEFAULT_IMAGE_TOOLS, type ImageToolSettings } from './image-tools';
import { FontPicker, fontClasses } from './per-note-font';
import { installTheme, themeStatus, THEME_NAME } from './theme-install';

const EMPTY_SPEC: ParseResult = { name: '', id: '', controls: [], problems: [] };

/** app.customCss is undocumented, so the cast lives here once. */
interface CustomCss { theme: string }
function customCss(app: unknown): CustomCss | undefined {
  return (app as { customCss?: CustomCss }).customCss;
}

interface StoredData {
  values: Values;
  /** Whether the first load has already gone looking for the theme. */
  autoInstallTried?: boolean;
  images?: Partial<ImageToolSettings>;
  looks?: Look[];
}

export default class N2OPaperSettingsPlugin extends Plugin {
  values: Values = {};
  spec: ParseResult = EMPTY_SPEC;
  autoInstallTried = false;
  images: ImageToolSettings = { ...DEFAULT_IMAGE_TOOLS };
  private tab: N2OPaperSettingsTab | null = null;
  /** The user's saved looks. */
  savedLooks: Look[] = [];
  private statusEl: HTMLElement | null = null;
  private actions: Action[] = [];

  async onload(): Promise<void> {
    await this.loadStored();
    await this.readTheme();

    this.tab = new N2OPaperSettingsTab(this.app, this);
    this.addSettingTab(this.tab);

    registerPictureCaptions((fn) => this.registerMarkdownPostProcessor(fn));
    registerImageMenu(this);
    registerImageTools(this, () => this.images, [flagRowsFor(this.app)]);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable', 'n2o-ps-status');
    setIcon(this.statusEl, 'palette');
    this.statusEl.setAttr('aria-label', THEME_NAME);
    this.registerDomEvent(this.statusEl, 'click', (ev) => this.quickMenu().showAtMouseEvent(ev));

    // Light/dark and theme switches change what applies and which controls exist.
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        void this.readTheme().then(() => {
          this.refresh();
          this.tab?.update();
        });
      }),
    );

    this.addCommand({
      id: 'set-font-for-this-note',
      name: 'Set the font for this note',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const classes = fontClasses(this.spec);
        if (!this.isActive() || !file || file.extension !== 'md' || !classes.length) return false;
        if (!checking) new FontPicker(this.app, classes, file).open();
        return true;
      },
    });

    this.addCommand({
      id: 'reload-theme-controls',
      name: 'Reload controls from the theme',
      callback: () => {
        void this.readTheme().then(() => {
          this.refresh();
          this.tab?.update();
          new Notice(`${THEME_NAME}: ${this.spec.controls.filter((c) => c.type !== 'heading').length} control(s) loaded.`);
        });
      },
    });

    this.actions = lookActions(this);
    for (const a of this.actions) {
      this.addCommand({
        id: a.id,
        name: a.name,
        icon: a.icon,
        checkCallback: (checking: boolean) => {
          if (!this.isActive() || !a.available()) return false;
          if (!checking) a.run();
          return true;
        },
      });
    }

    this.app.workspace.onLayoutReady(() => {
      this.refresh();
      void this.fetchThemeOnce();
    });
  }

  onunload(): void {
    reset(this.spec.controls);
  }

  async onExternalSettingsChange(): Promise<void> {
    await this.loadStored();
    this.refresh();
    this.tab?.update();
  }

  private async loadStored(): Promise<void> {
    const stored = (await this.loadData()) as StoredData | null;
    this.values = stored?.values ?? {};
    this.autoInstallTried = stored?.autoInstallTried === true;
    this.images = { ...DEFAULT_IMAGE_TOOLS, ...(stored?.images ?? {}) };
    this.savedLooks = (stored?.looks ?? []).map((l) => ({ ...l, builtIn: false }));
    // 1.1.1 and earlier stored this default, whose 100% row does nothing now that sizes are relative.
    if (this.images.customSizes === '25%, 50%, 100%') this.images.customSizes = DEFAULT_IMAGE_TOOLS.customSizes;
  }

  /** On a vault without the theme, fetch and select it once. The settings tab offers the same by hand. */
  private async fetchThemeOnce(): Promise<void> {
    const wanted = themeStatus(this.app) === 'absent' || !this.spec.controls.length;
    if (this.autoInstallTried || !wanted) return;
    this.autoInstallTried = true;
    await this.persist();
    try {
      await installTheme(this.app, () => {});
    } catch {
      /* offline or unreachable; the settings tab has the button */
    }
  }

  /** Read the controls from the installed theme.css (the @settings block is a comment, so it is not in the loaded stylesheet). */
  async readTheme(): Promise<void> {
    const path = `${this.app.vault.configDir}/themes/${THEME_NAME}/theme.css`;
    try {
      this.spec = parseSettingsBlock(await this.app.vault.adapter.read(path), parseYaml);
    } catch {
      this.spec = EMPTY_SPEC;
    }
    // A stored value equal to the theme default is no change; drop it.
    for (const c of this.spec.controls) if (c.id in this.values) store(this.values, c, this.values[c.id]);
  }

  /** N2O Paper is on screen and Obsidian is in dark mode, where it adds nothing. */
  lightOnlyInDark(): boolean {
    return this.activeTheme() === THEME_NAME && document.body.classList.contains('theme-dark');
  }

  activeTheme(): string {
    return customCss(this.app)?.theme ?? '';
  }

  /** Values apply only while N2O Paper is the active theme and Obsidian is light. */
  isActive(): boolean {
    return this.activeTheme() === THEME_NAME && !this.lightOnlyInDark();
  }

  refresh(): void {
    const active = this.isActive();
    this.statusEl?.toggle(active);
    if (!active) {
      reset(this.spec.controls);
      return;
    }
    apply(this.spec.controls, this.values);
  }

  async persist(): Promise<void> {
    const data: StoredData = {
      values: this.values,
      autoInstallTried: this.autoInstallTried,
      images: this.images,
      looks: this.savedLooks,
    };
    await this.saveData(data);
    this.refresh();
  }

  /** The built-in looks, then the saved ones. */
  looks(): Look[] {
    return [...builtInLooks(this.spec.controls), ...this.savedLooks];
  }

  lookInForce(): Look | undefined {
    return this.looks().find((l) => lookMatches(this.spec.controls, this.values, l));
  }

  async applyLook(look: Look): Promise<void> {
    this.values = withLook(this.spec.controls, this.values, look);
    await this.persist();
    this.tab?.update();
  }

  async saveLook(title: string): Promise<void> {
    this.savedLooks.push({ id: `look-${Date.now()}`, title, values: { ...this.values }, builtIn: false });
    await this.persist();
  }

  valueOf(c: Control): string | number | boolean | undefined {
    return effective(c, this.values, false);
  }

  /** Toggle a toggle, or move a select or a number with a `cycle` list to its next value. */
  async step(c: Control): Promise<void> {
    const cur = this.valueOf(c);
    if (c.type === 'class-toggle') {
      await this.setValue(c, cur !== true);
    } else if (c.type === 'variable-number') {
      const list = c.cycle ?? [];
      const at = list.findIndex((v) => (v === null ? cur === undefined || cur === '' : Number(cur) === v));
      await this.setValue(c, list[(at + 1) % list.length] ?? undefined);
    } else {
      const s = String(cur ?? c.options[0]);
      await this.setValue(c, c.options[(c.options.indexOf(s) + 1) % c.options.length]);
    }
    new Notice(`${c.title}: ${this.describe(c)}`, 1500);
  }

  async setValue(c: Control, v: string | number | boolean | undefined): Promise<void> {
    store(this.values, c, v);
    await this.persist();
    this.tab?.update();
  }

  private describe(c: Control): string {
    const v = effective(c, this.values, false);
    if (c.type === 'class-toggle') return v === true ? 'on' : 'off';
    if (c.type === 'variable-number') return v === undefined || v === '' ? 'default' : `${String(v)}${c.unit ?? ''}`;
    const s = String(v ?? c.options[0]);
    return c.labels?.[s] ?? optionLabel(s, c.options);
  }

  /** The status-bar menu: looks, palette, then the actions marked for the menu, ticked when on. */
  private quickMenu(): Menu {
    const menu = new Menu();
    const looks = this.looks();
    if (looks.length) {
      const current = this.lookInForce();
      menu.addItem((i) => i.setTitle('Look').setIsLabel(true));
      for (const l of looks) {
        menu.addItem((i) => i.setTitle(l.title).setChecked(current?.id === l.id && current.builtIn === l.builtIn).onClick(() => void this.applyLook(l)));
      }
      menu.addSeparator();
    }
    const palette = this.spec.controls.find((c) => c.id === 'n2o-palette' && c.options.length > 1);
    if (palette) {
      const cur = String(this.valueOf(palette) ?? palette.options[0]);
      menu.addItem((i) => i.setTitle(palette.title).setIsLabel(true));
      for (const o of palette.options) {
        menu.addItem((i) => i.setTitle(palette.labels?.[o] ?? optionLabel(o, palette.options)).setChecked(o === cur)
          .onClick(() => void this.setValue(palette, o)));
      }
      menu.addSeparator();
    }
    for (const a of this.actions.filter((x) => x.inMenu && x.available())) {
      menu.addItem((i) => i.setTitle(a.label?.() ?? a.name)
        .setIcon(a.icon).setChecked(a.checked?.() === true).onClick(() => a.run()));
    }
    return menu;
  }
}
