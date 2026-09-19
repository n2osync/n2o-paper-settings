/**
 * N2O Settings.
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
import { N2OPaperSettingsTab, type TabId } from './settings-tab';
import { registerPictureCaptions } from './picture-captions';
import { registerImageMenu } from './image-menu';
import { FontPicker, fontClasses } from './per-note-font';
import { installTheme, themeStatus } from './theme-install';

const THEME_NAME = 'N2O Paper';

const EMPTY_SPEC: ParseResult = { name: '', id: '', controls: [], problems: [] };

/** app.customCss is undocumented, so the cast lives here once. */
interface CustomCss { theme: string; themes?: Record<string, unknown> }
function customCss(app: unknown): CustomCss | undefined {
  return (app as { customCss?: CustomCss }).customCss;
}

/** `*` means every theme. Anything else is a theme name to bind to. */

interface StoredData {
  values: Values;
  /** Section titles the user has left expanded. Remembered so a tab that was
   *  set up once does not need setting up again on every visit. */
  open?: string[];
  /** The tab the panel was last showing. */
  activeTab?: TabId;
  /** Whether the first load has already gone looking for the theme. */
  autoInstallTried?: boolean;
}

export default class N2OPaperSettingsPlugin extends Plugin {
  values: Values = {};
  open: string[] = [];
  activeTab: TabId = '';
  spec: ParseResult = EMPTY_SPEC;
  autoInstallTried = false;
  /** Kept so a theme or mode change can redraw the tab while it is open. */
  private tab: N2OPaperSettingsTab | null = null;

  async onload(): Promise<void> {
    const stored = (await this.loadData()) as StoredData | null;
    this.values = stored?.values ?? {};
    this.open = stored?.open ?? [];
    this.activeTab = stored?.activeTab ?? '';
    this.autoInstallTried = stored?.autoInstallTried === true;
    await this.readTheme();

    this.tab = new N2OPaperSettingsTab(this.app, this);
    this.addSettingTab(this.tab);

    /* A picture with a flag on it cannot be captioned by the theme alone: the
     * caption is the alt text and CSS cannot strip the flag word out of it.
     * This computes the leftover and hands it to the theme on an attribute. */
    registerPictureCaptions((fn) => this.registerMarkdownPostProcessor(fn));
    registerImageMenu(this);

    // Light and dark change which half of every themed colour is in force, and
    // a theme switch changes the control list entirely, so both re-run this.
    // An open settings tab is redrawn too: it says whether these settings are
    // being applied, and that sentence was left behind by a theme or mode
    // change, still naming the theme the reader had just switched away from.
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        void this.readTheme().then(() => {
          this.refresh();
          if (this.tab?.containerEl.isConnected) this.tab.display();
        });
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

    this.app.workspace.onLayoutReady(() => {
      this.refresh();
      void this.fetchThemeOnce();
    });
  }

  /**
   * Get the theme itself, once, on a vault that does not have it.
   *
   * Without N2O Paper this plugin has nothing to render: it reads its controls
   * out of the theme. So the first load fetches it and selects it, and the
   * attempt is recorded either way, so a vault that does not want the theme is
   * never asked twice. The card in the settings tab offers the same thing by
   * hand afterwards.
   */
  private async fetchThemeOnce(): Promise<void> {
    // Absent, or selected with an unreadable theme.css: the second case is a
    // folder deleted by hand, where the tab would otherwise come up empty.
    const wanted = themeStatus(this.app) === 'absent' || !this.spec.controls.length;
    if (this.autoInstallTried || !wanted) return;
    this.autoInstallTried = true;
    await this.persist();
    try {
      await installTheme(this.app, () => {});
    } catch {
      /* offline, or the release is unreachable. The settings tab has the button. */
    }
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
    return this.activeTheme() === THEME_NAME;
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
    const data: StoredData = {
      values: this.values,
      open: this.open,
      activeTab: this.activeTab,
      autoInstallTried: this.autoInstallTried,
    };
    await this.saveData(data);
    this.refresh();
  }
}
