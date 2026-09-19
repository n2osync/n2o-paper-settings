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
import { effective, propsFor, sanitize } from './apply';
import type N2OPaperSettingsPlugin from './main';

/** Which tab the panel is showing. Persisted, so it opens where you left it. */
export type TabId = string;

/** A section, and the subsections folded inside it. */
interface Group {
  title: string;
  /** Carried from the heading that opened this group, e.g. "Advanced". */
  badge?: string;
  /** Section only: its groups render open instead of folded. */
  flat?: boolean;
  /** Section only: no header drawn. */
  hideTitle?: boolean;
  controls: Control[];
  children: Group[];
}

export class N2OPaperSettingsTab extends PluginSettingTab {
  private plugin: N2OPaperSettingsPlugin;
  private query = '';
  private groupsEl: HTMLDivElement | null = null;
  /** The tab bar, so a search can step it back without a full redraw. */
  private tabsEl: HTMLDivElement | null = null;
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

  /**
   * ONE TAB PER SECTION, and the tab is the section's header.
   *
   * The first split here was Theme against General, which sorted by what KIND
   * of thing something is when the problem was always how much sits on one
   * screen: it put 118 controls behind one tab and four rarely-touched rows
   * behind the other, so the bar bought almost nothing. Six sections is the
   * split that does something. Each tab is four to seven groups, which is one
   * screen, and the second rank disappears because the tab IS the heading.
   *
   * Three things sit ABOVE the bar and are never tabbed:
   *
   *   the notices     they say why a control is doing nothing, and an answer
   *                   behind an unclicked tab is no answer
   *   the theme card  drawn only when the theme is missing or not active, in
   *                   which case the whole panel is inert and the one control
   *                   that fixes it must not be buried in General
   *   the filter      it searches every section, not the open one, so a hit in
   *                   a tab you are not on is still found
   */
  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.liveSwatches = [];
    this.groupsEl = null;

    const { controls, problems } = this.plugin.spec;

    if (!controls.length) {
      this.renderThemeCard(containerEl.createDiv({ cls: 'n2o-ps-top' }));
      return;
    }

    this.renderNotices(containerEl, problems);
    this.renderThemeCard(containerEl.createDiv({ cls: 'n2o-ps-top' }));

    const sections = this.groups();
    const ids = sections.map((s) => s.title);
    const active = ids.includes(this.plugin.activeTab) ? this.plugin.activeTab : ids[0];

    /* ONLY WHAT IS TRUE ON EVERY TAB LIVES UP HERE. The sync row says which
     * other N2O plugin is in this vault, which does not change as you move
     * between tabs. Export and Import are not like that: they are a thing you
     * do once, so they sit at the foot of the first tab rather than riding
     * above all six. */
    renderSyncRow(this.app, containerEl.createDiv({ cls: 'n2o-ps-top' }), () => this.display());

    /* THE FILTER IS ABOVE THE BAR BECAUSE IT SEARCHES ACROSS IT. It sat under
     * the tabs, which says "this searches General", and it does not: it walks
     * every section and returns hits from tabs you are not on. Where a control
     * sits is what it claims. */
    this.renderFilter(containerEl);

    const bar = containerEl.createDiv({ cls: 'n2o-ps-tabs' });
    this.tabsEl = bar;
    for (const id of ids) {
      // No tab is the active one mid-search, or the bar claims you are in
      // General while the results in front of you came from Code.
      const b = bar.createEl('button', {
        cls: 'n2o-ps-tab' + (id === active ? ' is-active' : ''),
        text: id,
      });
      b.addEventListener('click', () => {
        if (this.plugin.activeTab === id) return;
        this.plugin.activeTab = id;
        void this.plugin.persist();
        this.query = '';
        this.display();
      });
    }

    this.renderGroups(containerEl);
  }

  /** Anything that says these settings are not reaching the page. Never tabbed. */
  private renderNotices(host: HTMLElement, problems: string[]): void {
    if (this.plugin.lightOnlyInDark()) {
      const note = host.createDiv({ cls: 'n2o-ps-problems' });
      note.createEl('strong', { text: 'N2O Paper is a light theme, and Obsidian is in dark mode.' });
      note.createDiv({
        text: "In dark mode the theme steps aside and Obsidian's own dark look shows, so nothing here is applied. Your values are kept for when you switch back to light.",
      });
    } else if (!this.plugin.isActive()) {
      const note = host.createDiv({ cls: 'n2o-ps-problems' });
      note.createEl('strong', {
        text: `These settings paint N2O Paper, and the current theme is "${this.plugin.activeTheme() || 'Obsidian default'}".`,
      });
      note.createDiv({
        text: 'Nothing is being applied, so no other theme is touched. Your values are kept. Switch to N2O Paper under Appearance.',
      });
    }

    if (problems.length) {
      const warn = host.createDiv({ cls: 'n2o-ps-problems' });
      warn.createEl('strong', { text: `${problems.length} control(s) in the theme could not be read:` });
      const list = warn.createEl('ul');
      for (const p of problems) list.createEl('li', { text: p });
    }
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
    let group: Group | null = null;
    let cluster: Group | null = null;
    const mk = (c: Control): Group => ({
      title: c.title, badge: c.badge, flat: c.flat, hideTitle: c.hideTitle, controls: [], children: [],
    });

    for (const c of this.plugin.spec.controls) {
      if (c.type === 'heading') {
        const lv = c.level ?? 1;
        if (lv >= 3 && group) { cluster = mk(c); group.children.push(cluster); }
        else if (lv === 2 && section) { group = mk(c); cluster = null; section.children.push(group); }
        else { section = mk(c); group = null; cluster = null; out.push(section); }
        continue;
      }
      const target = cluster ?? group ?? section;
      if (!target) {
        section = { title: 'Other', controls: [], children: [] };
        out.push(section);
        section.controls.push(c);
        continue;
      }
      target.controls.push(c);
    }

    const prune = (g: Group): Group => ({
      ...g,
      children: g.children.filter((k) => k.controls.length || k.children.length).map(prune),
    });
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
    /* Typing redraws the body only, so the bar's own state is set from here.
     * Mid-search no tab is active: the results below come from every section,
     * and a highlighted General while you are reading a hit from Code is the
     * bar telling you something untrue. */
    this.tabsEl?.classList.toggle('is-searching', !!q);
    for (const b of Array.from(this.tabsEl?.children ?? [])) {
      b.classList.toggle('is-muted', !!q);
    }

    const hit = (c: Control) => c.title.toLowerCase().includes(q)
      || c.id.toLowerCase().includes(q)
      || (c.description ?? '').toLowerCase().includes(q);

    /* A GROUP NAME IS A SEARCH TERM. "syntax colours" and "coil binding" are
     * what the panel calls those things, so typing one has to find them even
     * though no single control repeats the words. A group whose own name
     * matches offers all of its controls. */
    const named = new Set<Control>();
    if (q) {
      const walk = (g: Group) => {
        const self = g.title.toLowerCase().includes(q);
        const take = (k: Group) => { for (const c of k.controls) named.add(c); k.children.forEach(take); };
        if (self) take(g);
        g.children.forEach(walk);
      };
      this.groups().forEach(walk);
    }
    const matches = (c: Control) => !q || hit(c) || named.has(c);

    const sections = this.groups();
    const ids = sections.map((s) => s.title);
    const active = ids.includes(this.plugin.activeTab) ? this.plugin.activeTab : ids[0];

    /* A SEARCH LEAVES THE TAB BEHIND. Filtering only the open tab would hide
     * the hit somebody is looking for behind a tab they have not clicked,
     * which is the whole failure the tabs were meant to fix. Every section is
     * searched and each keeps its name, so a hit says where it lives. */
    if (q) {
      let shown = 0;
      for (const g of sections) shown += this.renderSection(host, g, q, matches, true);
      if (!shown) host.createDiv({ cls: 'n2o-ps-empty', text: `Nothing matches "${this.query}".` });
      return;
    }

    const g = sections.find((s) => s.title === active);
    if (g) this.renderSection(host, g, q, matches, false);

    /* The way out, at the foot of the first tab and nowhere else. A rule above
     * it because it is not another group of controls: everything over the line
     * changes how the theme looks, and this moves the whole set somewhere. */
    if (active === ids[0]) {
      host.createDiv({ cls: 'n2o-ps-rule' });
      this.renderToolbar(host);
    }
  }

  /**
   * Is this control on screen yet?
   *
   * A control may name a class-toggle in `showWhen`. Until that toggle is on
   * the control is not drawn at all, rather than drawn empty: an empty text
   * box reads as broken, and "blank means the theme stays out of it" is a
   * rule nobody can see. The toggle says what is happening, and the box
   * appears once there is a decision to make.
   */
  private revealed(c: Control): boolean {
    return !c.showWhen || this.plugin.values[c.showWhen] === true;
  }

  /** Every control that some other control's `showWhen` points at. */
  private gatesOthers(id: string): boolean {
    return this.plugin.spec.controls.some((c) => c.showWhen === id);
  }

  /**
   * One section: a plain header on the background, then a card per group.
   *
   * Obsidian's own settings pages are the model. "Account" and "Font" are bold
   * text sitting on the background, each owning one short card of hairline
   * separated rows, and nothing on those pages collapses. We had copied the
   * structure and kept our own chrome: a title inside a card with a fold on
   * it, which is what made 118 controls read as a wall no matter how well
   * they were grouped.
   *
   * Nothing folds any more. The headers are the landmarks and the filter is
   * how you get somewhere directly. Counts stay, against Obsidian's habit,
   * because they say how much sits behind a name before you scroll into it.
   */
  private renderSection(
    host: HTMLElement,
    g: Group,
    q: string,
    matches: (c: Control) => boolean,
    showHeader = true,
  ): number {
    const shows = (c: Control) => matches(c) && this.revealed(c);
    const own = g.controls.filter(shows);
    const deep = (k: Group): Control[] => [...k.controls, ...k.children.flatMap(deep)];
    const childHits = g.children.map((k) => ({ group: k, hits: deep(k).filter(shows) }));
    const total = own.length + childHits.reduce((a, k) => a + k.hits.length, 0);
    if (!total) return 0;

    /* hideTitle suppresses the header on the section's own tab, where the tab
     * is the heading. In SEARCH RESULTS it has to come back: a hit with no
     * section name does not say which tab it lives in, which is the one
     * thing a result has to tell you. */
    if (showHeader && (q || !g.hideTitle)) {
      const head = host.createDiv({ cls: 'n2o-ps-section-head' });
      head.createSpan({ cls: 'n2o-ps-section-title', text: g.title });
      head.createSpan({ cls: 'n2o-ps-count', text: String(total) });
    }

    if (own.length) this.renderCard(host, null, undefined, g, own, q, matches, false, !!g.hideTitle);
    for (const k of childHits) {
      if (!k.hits.length) continue;
      this.renderCard(host, k.group.title, k.group.badge, k.group,
                      k.group.controls.filter(shows), q, matches, !g.flat, !!g.hideTitle);
    }
    return total;
  }

  /**
   * A group: its name on the background, its controls in one card.
   *
   * SMART FOLDING, and the smart part is WHERE the fold goes. Folding the
   * whole "Headings, level by level" group put one triangle in front of 19
   * rows, which is the same wall with a lid on it: you open it and you are
   * back to scrolling H1 through H6. The fold belongs at the level somebody
   * actually thinks in, so each heading level folds on its own and the group
   * around them stays open.
   *
   * A group with no natural split inside it (Syntax colours, 11 rows of one
   * kind) still folds as a whole, because there is nothing smaller to fold.
   */
  private renderCard(
    host: HTMLElement,
    title: string | null,
    badge: string | undefined,
    g: Group,
    controls: Control[],
    q: string,
    matches: (c: Control) => boolean,
    fold: boolean,
    /** The section drew no header, so these names are its top rank. */
    lead: boolean,
  ): void {
    const clusters = g.children
      .map((k) => ({ group: k, hits: k.controls.filter((c) => matches(c) && this.revealed(c)) }))
      .filter((k) => k.hits.length);

    const head = (into: HTMLElement, tag: 'div' | 'summary', cls: string, n: number) => {
      const h = into.createEl(tag, { cls: lead ? `${cls} n2o-ps-lead` : cls });
      h.createSpan({ cls: 'n2o-ps-card-title', text: title ?? '' });
      if (badge) h.createSpan({ cls: 'n2o-ps-group-badge', text: badge });
      h.createSpan({ cls: 'n2o-ps-count', text: String(n) });
      return h;
    };
    const total = controls.length + clusters.reduce((a, k) => a + k.hits.length, 0);

    // Every group folds, except in a section that declares itself flat.
    if (title && fold) {
      const det = host.createEl('details', { cls: 'n2o-ps-fold' });
      det.open = q ? true : this.plugin.open.includes(title);
      head(det, 'summary', 'n2o-ps-card-head n2o-ps-card-head-fold', total);
      this.rememberFold(det, title, q);
      this.fillCard(det, controls, clusters, title, q);
      return;
    }

    if (title) head(host, 'div', 'n2o-ps-card-head', total);
    this.fillCard(host, controls, clusters, title, q);
  }

  /** The card itself: plain rows, then a fold per cluster. */
  private fillCard(
    host: HTMLElement,
    controls: Control[],
    clusters: { group: Group; hits: Control[] }[],
    title: string | null,
    q: string,
  ): void {
    const card = host.createDiv({ cls: 'n2o-ps-card' });
    for (const c of controls) this.renderControl(card, c);
    for (const k of clusters) {
      const key = `${title ?? ''} / ${k.group.title}`;
      const det = card.createEl('details', { cls: 'n2o-ps-cluster' });
      det.open = q ? true : this.plugin.open.includes(key);
      const sum = det.createEl('summary', { cls: 'n2o-ps-cluster-head' });
      sum.createSpan({ cls: 'n2o-ps-cluster-title', text: k.group.title });
      sum.createSpan({ cls: 'n2o-ps-count', text: String(k.hits.length) });
      this.rememberFold(det, key, q);
      const body = det.createDiv({ cls: 'n2o-ps-cluster-body' });
      for (const c of k.hits) this.renderControl(body, c);
    }
  }

  /** Persist which folds the reader left open, keyed by a title that is unique. */
  private rememberFold(det: HTMLDetailsElement, key: string, q: string): void {
    det.addEventListener('toggle', () => {
      if (q) return; // a filtered view is temporary, do not remember it
      const set = new Set(this.plugin.open);
      if (det.open) set.add(key); else set.delete(key);
      this.plugin.open = [...set];
      void this.plugin.persist();
    });
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

  private renderToolbar(el: HTMLElement): void {
    /* A GROUP HEADING, not a row label. This is the last group on the tab and
     * it has to read as one: at .setting-item-name size it sat a rank below
     * "Paper or flat" directly above it, which says it belongs to that group
     * rather than standing on its own. Same classes as every other group name
     * in this section, lead included, so it cannot drift from them. */
    const head = el.createDiv({ cls: 'n2o-ps-card-head n2o-ps-lead' });
    head.createSpan({ cls: 'n2o-ps-card-title', text: 'Your settings' });

    const card = el.createDiv({ cls: 'n2o-ps-card' });
    new Setting(card)
      .setDesc('Export writes every value you have changed to the clipboard. Keep it somewhere. Import puts them back.')
      .addButton((b) => b
        .setButtonText('Export')
        .onClick(async () => {
          // Clipboard writes reject on a denied permission and on some hosts
          // have no clipboard at all. Unhandled, the button just did nothing.
          try {
            await navigator.clipboard.writeText(JSON.stringify(this.plugin.values, null, 2));
            new Notice(`Copied ${Object.keys(this.plugin.values).length} setting(s) to the clipboard.`);
          } catch {
            new Notice('Could not write to the clipboard. Your settings are unchanged.');
          }
        }))
      .addButton((b) => b
        .setButtonText('Import')
        .onClick(async () => {
          /* NOTHING IS WRITTEN UNTIL IT IS KNOWN GOOD. The old order assigned,
           * persisted, and only then applied, so a value that threw on apply
           * had already replaced the config it failed to become. */
          let raw: unknown;
          try {
            raw = JSON.parse(await navigator.clipboard.readText());
          } catch {
            new Notice('Could not read an N2O Paper export from the clipboard. Nothing was changed.');
            return;
          }

          const controls = this.plugin.spec.controls;
          if (!controls.length) {
            new Notice('N2O Paper is not installed, so there is nothing to import into.');
            return;
          }

          const result = sanitize(controls, raw);
          if (!result || !Object.keys(result.values).length) {
            new Notice('No N2O Paper settings in that clipboard content. Nothing was changed.');
            return;
          }

          this.plugin.values = result.values;
          await this.plugin.persist();
          this.display();
          const n = Object.keys(result.values).length;
          new Notice(result.dropped
            ? `Imported ${n} setting(s). Ignored ${result.dropped} this theme does not have.`
            : `Imported ${n} setting(s).`);
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
          // A toggle that gates another control has to redraw the tab, or the
          // box it reveals does not appear until the next visit.
          .onChange((v) => void set(v || undefined).then(() => {
            if (this.gatesOthers(c.id)) this.display();
          })));
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
