/**
 * The settings tab. Renders whatever the theme declares, in the order it
 * declares it, grouped by the headings the theme already carries.
 *
 * Export and Import exist because a stray Reset can wipe a hand-built palette
 * with no way back. So this ships with a way out from the first version, and
 * Reset asks first.
 */
import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { Control } from './parse';
import { brandMark, renderSyncRow } from './n2o-sync';
import { installTheme, selectTheme, themeStatus, THEME_NAME as PAPER } from './theme-install';
import type { Values } from './apply';
import { effective, propsFor } from './apply';
import type N2OPaperSettingsPlugin from './main';
import { EVERY_THEME } from './main';

const THEME_NAME = 'N2O Paper';

/** A section, and the subsections folded inside it. */
interface Group {
  title: string;
  controls: Control[];
  children: Group[];
}

export class N2OPaperSettingsTab extends PluginSettingTab {
  private plugin: N2OPaperSettingsPlugin;
  private query = '';
  private groupsEl: HTMLDivElement | null = null;
  /** Colour swatches showing the page's live value, refreshed when a class control changes it. */
  private liveSwatches: (() => void)[] = [];

  constructor(app: App, plugin: N2OPaperSettingsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** The element Obsidian scrolls when the settings list is taller than the window. */
  private scroller(): HTMLElement {
    return (this.containerEl.closest('.vertical-tab-content') as HTMLElement | null) ?? this.containerEl;
  }

  /**
   * Redraw, and stay where the reader was.
   *
   * Emptying the container sets scrollTop to 0, so a redraw used to throw the
   * page back to the top: change one setting through its reset arrow, or the
   * Apply to dropdown, and you lost your place in a list of 124 controls. The
   * position is taken before the rebuild and put back after the browser has
   * laid the new content out.
   */
  display(): void {
    const scroller = this.scroller();
    const top = scroller.scrollTop;
    this.render();
    if (!top) return;
    // Obsidian 1.13 opens settings in its OWN window, and the main window's
    // timers are throttled while that one has focus, so the restore is
    // scheduled on the window the list actually lives in.
    const win = scroller.ownerDocument.defaultView ?? window;
    const restore = () => { scroller.scrollTop = top; };
    win.requestAnimationFrame(restore);
    win.setTimeout(restore, 60);
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.liveSwatches = [];
    this.groupsEl = null;

    const { controls, problems } = this.plugin.spec;

    // One box at the top, two slim rows: the theme this tab is for, and the
    // sync plugin. They were two tall cards with the scope control and a
    // warning wedged between them.
    const top = containerEl.createDiv({ cls: 'n2o-ps-top' });
    const themeCardShown = this.renderThemeCard(top);
    renderSyncRow(this.app, top, () => this.display());

    if (!controls.length) return;

    this.renderScope(containerEl);

    // A reader whose settings are parked is told so, rather than left
    // wondering why a slider does nothing. The theme card already says it when
    // it is on screen, so this is the dark-mode case and the odd scope.
    if (this.plugin.lightOnlyInDark()) {
      const note = containerEl.createDiv({ cls: 'n2o-ps-problems' });
      note.createEl('strong', { text: 'N2O Paper is a light theme, and Obsidian is in dark mode.' });
      note.createDiv({
        text: "In dark mode the theme steps aside and Obsidian's own dark look shows, so nothing here is applied. Your values are kept for when you switch back to light.",
      });
    } else if (!this.plugin.isActive() && !themeCardShown) {
      const note = containerEl.createDiv({ cls: 'n2o-ps-problems' });
      note.createEl('strong', {
        text: `These settings apply to "${this.plugin.scope}", and the current theme is "${this.plugin.activeTheme() || 'Obsidian default'}".`,
      });
      note.createDiv({
        text: 'Nothing is being applied, so no other theme is touched. Your values are kept. Switch theme in Appearance, or change Apply to above.',
      });
    }

    this.renderToolbar(containerEl);

    if (problems.length) {
      const warn = containerEl.createDiv({ cls: 'n2o-ps-problems' });
      warn.createEl('strong', { text: `${problems.length} control(s) in the theme could not be read:` });
      const list = warn.createEl('ul');
      for (const p of problems) list.createEl('li', { text: p });
    }

    this.renderFilter(containerEl);
    this.renderGroups(containerEl);
  }

  /**
   * Turn the theme's flat sequence into a two-level tree.
   *
   * The block is a list, not a tree: a heading, then the controls under it.
   * The heading's `level` is what expresses depth, so level 1 opens a section
   * and level 2 opens a subsection inside it. That is how everything the theme
   * has accumulated can be folded under one heading without the theme needing
   * a nested format.
   *
   * Two levels at most, deliberately.
   */
  private groups(): Group[] {
    const out: Group[] = [];
    let section: Group | null = null;
    let sub: Group | null = null;

    for (const c of this.plugin.spec.controls) {
      if (c.type === 'heading') {
        if ((c.level ?? 1) >= 2 && section) {
          sub = { title: c.title, controls: [], children: [] };
          section.children.push(sub);
        } else {
          section = { title: c.title, controls: [], children: [] };
          sub = null;
          out.push(section);
        }
        continue;
      }
      const target = sub ?? section;
      if (!target) {
        section = { title: 'Other', controls: [], children: [] };
        out.push(section);
        section.controls.push(c);
        continue;
      }
      target.controls.push(c);
    }

    const prune = (g: Group): Group => ({ ...g, children: g.children.filter((k) => k.controls.length).map(prune) });
    return out.map(prune).filter((g) => g.controls.length || g.children.length);
  }

  /**
   * A filter for the long list of controls.
   *
   * Matching a section opens it, so a search never leaves its own results
   * hidden behind a collapsed heading.
   */
  private renderFilter(el: HTMLElement): void {
    new Setting(el)
      .setName('Find a setting')
      .addText((t) => {
        t.setPlaceholder('heading, tag, callout, radius...');
        t.setValue(this.query);
        t.onChange((v) => {
          this.query = v;
          this.renderGroupsInto();
        });
        // Focus only while a search is actually in progress, and never scroll
        // to do it: focusing on every redraw dragged the list back to the top.
        if (this.query) window.setTimeout(() => t.inputEl.focus({ preventScroll: true }), 0);
      });
    this.groupsEl = el.createDiv();
  }

  private renderGroups(el: HTMLElement): void {
    if (!this.groupsEl) this.groupsEl = el.createDiv();
    this.renderGroupsInto();
  }

  private renderGroupsInto(): void {
    const host = this.groupsEl;
    if (!host) return;
    host.empty();

    const q = this.query.trim().toLowerCase();
    const matches = (c: Control) => !q
      || c.title.toLowerCase().includes(q)
      || c.id.toLowerCase().includes(q)
      || (c.description ?? '').toLowerCase().includes(q);

    // Built once. Calling groups() inside the loop returns fresh objects, so an
    // identity comparison against groups()[0] could never be true and the
    // first section never opened on a first visit.
    const groups = this.groups();
    const firstVisit = this.plugin.open.length === 0;
    let shown = 0;

    for (const [i, g] of groups.entries()) {
      const rendered = this.renderGroup(host, g, q, matches, firstVisit && i === 0, 0);
      shown += rendered;
    }

    if (!shown) {
      host.createDiv({ cls: 'n2o-ps-empty', text: `Nothing matches "${this.query}".` });
    }
  }

  /** One section, and its subsections. Returns how many controls it showed. */
  private renderGroup(
    host: HTMLElement,
    g: Group,
    q: string,
    matches: (c: Control) => boolean,
    openByDefault: boolean,
    depth: number,
  ): number {
    const own = g.controls.filter(matches);
    const childHits = g.children.map((k) => ({ group: k, hits: k.controls.filter(matches) }));
    const total = own.length + childHits.reduce((a, k) => a + k.hits.length, 0);
    if (!total) return 0;

    const all = g.controls.length + g.children.reduce((a, k) => a + k.controls.length, 0);

    const details = host.createEl('details', { cls: depth ? 'n2o-ps-group n2o-ps-sub' : 'n2o-ps-group' });
    // A search opens everything it matched; otherwise remember what the user
    // left open, and open the first section on a first visit so the tab is
    // not a list of closed headings.
    details.open = q ? true : this.plugin.open.includes(g.title) || openByDefault;

    const summary = details.createEl('summary', { cls: 'n2o-ps-group-summary' });
    summary.createSpan({ cls: 'n2o-ps-group-title', text: g.title });
    summary.createSpan({
      cls: 'n2o-ps-group-count',
      text: q ? `${total} of ${all}` : String(all),
    });

    details.addEventListener('toggle', () => {
      if (q) return; // a filtered view is temporary, do not remember it
      const set = new Set(this.plugin.open);
      if (details.open) set.add(g.title); else set.delete(g.title);
      this.plugin.open = [...set];
      void this.plugin.persist();
    });

    const body = details.createDiv({ cls: 'n2o-ps-group-body' });
    for (const c of own) this.renderControl(body, c);
    for (const k of childHits) {
      if (!k.hits.length) continue;
      this.renderGroup(body, k.group, q, matches, false, depth + 1);
    }
    return total;
  }

  /**
   * The theme card. Only drawn when the theme is missing or is installed but
   * not selected, because this plugin does nothing at all without it.
   */
  private renderThemeCard(el: HTMLElement): boolean {
    const status = themeStatus(this.app);
    const noControls = !this.plugin.spec.controls.length;
    // Selected, and yet there is nothing to render: the theme's folder was
    // deleted while appearance.json still names it, so Obsidian reports it as
    // the theme and the tab came up empty with no way out. Offer the download.
    if (status === 'active' && noControls) {
      const row = el.createDiv({ cls: 'n2o-ps-row' });
      const text = row.createDiv({ cls: 'n2o-ps-row-text' });
      const brandHead = text.createDiv({ cls: 'n2o-ps-sync-head' });
      brandHead.appendChild(brandMark());
      brandHead.createSpan({ cls: 'n2o-ps-sync-name', text: 'Paper' });
      text.createDiv({
        cls: 'n2o-ps-sync-body',
        text: `${PAPER} is selected, but its theme.css cannot be read, so there are no controls to show.`,
      });
      const line = text.createDiv({ cls: 'n2o-ps-sync-line' });
      const again = row.createDiv({ cls: 'n2o-ps-sync-actions' })
        .createEl('button', { cls: 'mod-cta', text: `Install ${PAPER} again` });
      again.onclick = async () => {
        again.disabled = true;
        try {
          await installTheme(this.app, (m) => line.setText(m));
        } catch (e) {
          line.setText(e instanceof Error ? e.message : String(e));
          again.disabled = false;
          return;
        }
        await this.plugin.readTheme();
        this.display();
      };
      return true;
    }
    if (status === 'active') return false;

    const row = el.createDiv({ cls: 'n2o-ps-row' });
    const text = row.createDiv({ cls: 'n2o-ps-row-text' });
    // The same mark as the Sync row: one wordmark across the theme and the
    // plugin, so the two rows read as N2O Paper and N2O Sync.
    const head = text.createDiv({ cls: 'n2o-ps-sync-head' });
    head.appendChild(brandMark());
    head.createSpan({ cls: 'n2o-ps-sync-name', text: 'Paper' });
    const body = text.createDiv({ cls: 'n2o-ps-sync-body' });
    const actions = row.createDiv({ cls: 'n2o-ps-sync-actions' });
    const line = text.createDiv({ cls: 'n2o-ps-sync-line' });

    if (status === 'installed') {
      body.setText(`Installed, and another theme is selected. These settings paint ${PAPER} only.`);
      const use = actions.createEl('button', { cls: 'mod-cta', text: `Switch to ${PAPER}` });
      use.onclick = () => {
        selectTheme(this.app);
        this.display();
      };
      return true;
    }

    body.setText('These controls come from the theme, which is not in this vault yet.');
    const get = actions.createEl('button', { cls: 'mod-cta', text: `Install ${PAPER}` });
    get.onclick = async () => {
      get.disabled = true;
      try {
        await installTheme(this.app, (m) => line.setText(m));
      } catch (e) {
        line.setText(e instanceof Error ? e.message : String(e));
        line.addClass('mod-warning');
        get.disabled = false;
        get.setText('Try again');
        return;
      }
      await this.plugin.readTheme();
      this.display();
    };
    return true;
  }

  /**
   * Where these values are allowed to take effect.
   *
   * Default is N2O Paper and only N2O Paper. Every value this plugin writes is
   * a generic Obsidian variable that any theme reads, so applying everywhere is
   * useful, and also a way to wreck a theme you were only trying out. Safe by
   * default.
   */
  private renderScope(el: HTMLElement): void {
    const themes = this.plugin.installedThemes();
    const setting = new Setting(el)
      .setName('Apply to')
      .setDesc('Which theme these settings paint. Anything else is left completely untouched.')
      .addDropdown((d) => {
        for (const t of themes) d.addOption(t, t === THEME_NAME ? `${t} (this theme)` : t);
        d.addOption(EVERY_THEME, 'Every theme');
        d.setValue(this.plugin.scope);
        d.onChange((v) => {
          this.plugin.scope = v;
          void this.plugin.persist().then(() => this.display());
        });
      });

    if (this.plugin.scope === EVERY_THEME) {
      setting.setClass('n2o-ps-global');
      const warn = el.createDiv({ cls: 'n2o-ps-problems' });
      warn.createEl('strong', { text: 'Applying to every theme.' });
      warn.createDiv({
        text: 'Your colours and sizes will now paint over whatever theme is selected. The on and off switches are N2O Paper features and do nothing elsewhere.',
      });
    }
  }

  private renderToolbar(el: HTMLElement): void {
    new Setting(el)
      .setName('Your settings')
      .setDesc('Export writes every value you have changed to the clipboard. Keep it somewhere. Import puts them back.')
      .addButton((b) => b
        .setButtonText('Export')
        .onClick(async () => {
          await navigator.clipboard.writeText(JSON.stringify(this.plugin.values, null, 2));
          new Notice(`Copied ${Object.keys(this.plugin.values).length} setting(s) to the clipboard.`);
        }))
      .addButton((b) => b
        .setButtonText('Import')
        .onClick(async () => {
          const text = await navigator.clipboard.readText();
          try {
            const parsed = JSON.parse(text) as Values;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
            this.plugin.values = parsed;
            await this.plugin.persist();
            this.display();
            new Notice(`Imported ${Object.keys(parsed).length} setting(s).`);
          } catch {
            new Notice('That clipboard content is not an N2O Paper export.');
          }
        }))
      .addButton((b) => b
        .setButtonText('Reset all')
        .setWarning()
        .onClick(async () => {
          const count = Object.keys(this.plugin.values).length;
          if (!count) { new Notice('Nothing to reset, everything is already at the theme default.'); return; }
          // The confirmation exists because a one-click Reset already cost a
          // full palette once.
          new ConfirmModal(this.app,
            `Reset all ${count} of your N2O Paper settings back to the theme defaults? Export them first if you want them back.`,
            'Reset all',
            async () => {
              this.plugin.values = {};
              await this.plugin.persist();
              this.display();
              new Notice('Reset to theme defaults.');
            }).open();
        }));
  }

  private renderControl(el: HTMLElement, c: Control): void {
    const isDark = document.body.classList.contains('theme-dark');
    const current = effective(c, this.plugin.values, isDark);
    const set = async (value: string | number | boolean | undefined) => {
      if (value === undefined || value === '') delete this.plugin.values[c.id];
      else this.plugin.values[c.id] = value;
      await this.plugin.persist();
    };

    const setting = new Setting(el).setName(c.title);
    if (c.description) setting.setDesc(c.description);

    switch (c.type) {
      case 'class-toggle':
        setting.addToggle((t) => t
          .setValue(current === true)
          .onChange((v) => void set(v || undefined)));
        break;

      case 'class-select':
      case 'variable-select':
        setting.addDropdown((d) => {
          for (const o of c.options) d.addOption(o, optionLabel(o, c.options));
          d.setValue(String(current ?? c.default ?? c.options[0] ?? ''));
          // A palette or any other class can change what a colour resolves
          // to, so the swatches that show live values follow it.
          d.onChange((v) => void set(v).then(() => this.liveSwatches.forEach((f) => f())));
        });
        break;

      case 'variable-number-slider':
        setting.addSlider((s) => s
          .setLimits(c.min ?? 0, c.max ?? 100, c.step ?? 1)
          .setValue(Number(current ?? c.default ?? 0))
          .onChange((v) => void set(v)));
        break;

      case 'variable-number':
        setting.addText((t) => t
          .setPlaceholder(String(c.default ?? ''))
          .setValue(current === undefined ? '' : String(current))
          .onChange((v) => {
            // Text that is not a number is ignored, not saved: a NaN would
            // persist as null and be written into the page as a broken value.
            if (v.trim() === '') return void set(undefined);
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            void set(n);
          }));
        break;

      case 'variable-color':
      case 'variable-themed-color': {
        // Until the user picks one, the swatch shows what the page is
        // actually painting, not the hex the theme declared as its default:
        // a palette turns every heading colour and the declared hex is only
        // ever one palette's answer.
        const props = propsFor(c);
        const live = () => (this.plugin.values[c.id] === undefined && props.length === 1 ? liveHex(props[0]) : undefined);
        // setValue fires the picker's own onChange, so a refresh after a
        // palette change used to save every live colour as the user's pick,
        // pinning it to that palette for good. One switch pinned
        // all eleven palette colours, so a refresh must not count as a pick.
        let refreshing = false;
        setting.addColorPicker((p) => {
          p.setValue(normaliseHex(live() ?? String(current ?? '#000000')))
            .onChange((v) => { if (!refreshing) void set(v); });
          this.liveSwatches.push(() => {
            const h = live();
            if (!h) return;
            refreshing = true;
            try { p.setValue(h); } finally { refreshing = false; }
          });
        });
        break;
      }

      case 'variable-text':
      default:
        setting.addText((t) => t
          .setPlaceholder(String(c.default ?? ''))
          .setValue(current === undefined ? '' : String(current))
          .onChange((v) => void set(v || undefined)));
        break;
    }

    // Every control can go back to the theme's own default on its own, so a
    // single mistake never needs a Reset All.
    if (this.plugin.values[c.id] !== undefined) {
      setting.addExtraButton((b) => b
        .setIcon('rotate-ccw')
        .setTooltip('Back to the theme default')
        .onClick(() => void set(undefined).then(() => this.display())));
    }
  }
}

/**
 * A dropdown should read `Medium`, not `n2o-headings-medium`.
 *
 * The label is derived rather than listed, by stripping the prefix the options
 * share: `n2o-headings-{medium,large,small}` gives Medium, Large, Small with
 * nothing to maintain. Hand-keeping the display names would be a second list
 * that would drift from the theme.
 *
 * The map below is only for names that capitalise in a way no rule can guess.
 */
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

/**
 * What the page is painting for a custom property right now, as #rrggbb.
 * The computed value of a custom property is text such as `hsl(355, 38%,
 * 30%)`; painting it onto a probe element is what turns it into rgb.
 */
function liveHex(prop: string): string | undefined {
  const raw = getComputedStyle(document.body).getPropertyValue(prop).trim();
  if (!raw) return undefined;
  const probe = document.body.createSpan();
  probe.style.color = raw;
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

/** A yes/no dialog in Obsidian's own style, in place of the browser's confirm(). */
class ConfirmModal extends Modal {
  constructor(app: App, private readonly text: string, private readonly action: string, private readonly onConfirm: () => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.text });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setWarning().onClick(() => { this.close(); void this.onConfirm(); }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
