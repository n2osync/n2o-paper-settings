/**
 * N2O Paper Settings.
 *
 * A theme is CSS and cannot draw a settings tab, so the controls N2O Paper
 * declares need a plugin to render them. This is that plugin, and it is the
 * same shape Minimal has used for years: theme plus companion.
 *
 * It does NOT carry its own list of
 * controls. It reads the /* @settings *\/ block out of the installed
 * theme.css. One source of truth, so a control added to the theme appears
 * here with no code change, and one that is deleted takes its stored value
 * with it.
 */
import { Plugin, Notice } from 'obsidian';
import { parseSettingsBlock, type ParseResult } from './parse';
import { apply, reset, type Values } from './apply';
import { N2OPaperSettingsTab } from './settings-tab';
import { FontPicker, fontClasses } from './per-note-font';

const THEME_NAME = 'N2O Paper';

const EMPTY_SPEC: ParseResult = { name: '', id: '', controls: [], problems: [] };

/** app.customCss is undocumented, so the cast lives here once. */
interface CustomCss { theme: string; themes?: Record<string, unknown> }
function customCss(app: unknown): CustomCss | undefined {
  return (app as { customCss?: CustomCss }).customCss;
}

/** `*` means every theme. Anything else is a theme name to bind to. */
export const EVERY_THEME = '*';

interface StoredData {
  /** Which theme these values apply to. A name, or EVERY_THEME. */
  scope: string;
  values: Values;
  /** Section titles the user has left expanded. Remembered so a tab that was
   *  set up once does not need setting up again on every visit. */
  open?: string[];
}

export default class N2OPaperSettingsPlugin extends Plugin {
  values: Values = {};
  scope: string = THEME_NAME;
  open: string[] = [];
  spec: ParseResult = EMPTY_SPEC;

  async onload(): Promise<void> {
    const stored = (await this.loadData()) as StoredData | null;
    this.values = stored?.values ?? {};
    this.scope = stored?.scope ?? THEME_NAME;
    this.open = stored?.open ?? [];
    await this.readTheme();

    this.addSettingTab(new N2OPaperSettingsTab(this.app, this));

    // Light and dark change which half of every themed colour is in force, and
    // a theme switch changes the control list entirely, so both re-run this.
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        void this.readTheme().then(() => this.refresh());
      }),
    );

    this.addCommand({
      id: 'set-font-for-this-note',
      name: 'Set the font for this note',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const classes = fontClasses(this.spec);
        if (!file || file.extension !== 'md' || !classes.length) return false;
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
          new Notice(`N2O Paper: ${this.spec.controls.filter((c) => c.type !== 'heading').length} control(s) loaded.`);
        });
      },
    });

    this.app.workspace.onLayoutReady(() => this.refresh());
  }

  onunload(): void {
    // A disabled plugin must leave nothing applied.
    reset(this.spec.controls);
  }

  /**
   * Read the control list from the installed theme.
   *
   * Reads the FILE rather than scraping the loaded stylesheet, because the
   * @settings block is a CSS comment and comments do not survive into
   * document.styleSheets.
   */
  async readTheme(): Promise<void> {
    const path = `${this.app.vault.configDir}/themes/${THEME_NAME}/theme.css`;
    try {
      const css = await this.app.vault.adapter.read(path);
      this.spec = parseSettingsBlock(css);
    } catch {
      // Not installed, or a different theme is selected. Not an error; the
      // settings tab explains it.
      this.spec = EMPTY_SPEC;
    }
  }

  /** N2O Paper is on screen and Obsidian is in dark mode, where it adds nothing. */
  lightOnlyInDark(): boolean {
    return this.activeTheme() === THEME_NAME && document.body.classList.contains('theme-dark');
  }

  /** The theme actually on screen right now. Empty string means Obsidian's own. */
  activeTheme(): string {
    return customCss(this.app)?.theme ?? '';
  }

  /** Every theme installed in this vault, for the Apply to picker. */
  installedThemes(): string[] {
    return Object.keys(customCss(this.app)?.themes ?? {}).sort();
  }

  /**
   * Should the values be on screen right now?
   *
   * Default is N2O Paper and nothing else, because every value written is a
   * generic Obsidian variable that any theme reads. Applying everywhere is a
   * real thing to want, and it is opt-in rather than the default.
   */
  isActive(): boolean {
    // N2O Paper is light only. In dark mode it steps aside and Obsidian's own
    // dark look shows, so nothing is painted over it either: an inline value
    // written there would be the half measure the theme refuses. Values are
    // kept for the switch back, and css-change re-runs this on every switch.
    if (this.lightOnlyInDark()) return false;
    if (this.scope === EVERY_THEME) return true;
    return this.activeTheme() === this.scope;
  }

  /**
   * Apply, but ONLY while N2O Paper is the selected theme.
   *
   * Everything this plugin writes is a generic Obsidian variable
   * (--h1-color, --background-primary) set inline on body, and every theme
   * reads those. So trying another theme would carry our colours onto it with
   * nothing on screen to explain why. Without the guard, a value set under
   * N2O Paper survived a switch to another theme and to no theme at all.
   */
  refresh(): void {
    if (!this.isActive()) {
      reset(this.spec.controls);
      return;
    }
    apply(this.spec.controls, this.values);
  }

  async persist(): Promise<void> {
    const data: StoredData = { scope: this.scope, values: this.values, open: this.open };
    await this.saveData(data);
    this.refresh();
  }
}
