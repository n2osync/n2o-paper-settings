/**
 * Set the font for ONE note.
 *
 * Obsidian's `cssclasses` frontmatter property is the native hook: whatever is
 * listed there becomes a class on that note's view container. It lands
 * on `.markdown-source-view`, never on body, which is why the theme's
 * font rules read an inherited variable rather than keying off `body`.
 *
 * Why cssclasses over a per-note id in plugin data:
 *
 *   It travels with the note. Rename it, move it, sync it, restore it from a
 *   backup, put it in git, and the choice goes along. A store keyed by id
 *   orphans an entry every time a note is deleted.
 *
 *   N2O Sync already protects it. `cssclasses` is on its preserved-local-keys
 *   list, so it survives a sync and is deliberately never pushed to Notion.
 *
 *   The note keeps its font if this plugin is uninstalled.
 */
import { App, FuzzySuggestModal, Notice, TFile } from 'obsidian';
import type { ParseResult } from './parse';

/** The font classes, read from the theme rather than listed again here. */
export function fontClasses(spec: ParseResult): string[] {
  const picker = spec.controls.find((c) => c.type === 'class-select' && c.id === 'n2o-font-type');
  return picker?.options ?? [];
}

/** `n2o-font-iawriter-quattro` reads better as `iA Writer Quattro`. */
function label(cls: string): string {
  const bare = cls.replace(/^n2o-font-/, '');
  if (bare === 'default') return 'Use the vault setting';
  if (bare === 'ibm') return 'IBM Plex';
  if (bare === 'fira') return 'Fira Code';
  if (bare === 'iawriter-quattro') return 'iA Writer Quattro';
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export class FontPicker extends FuzzySuggestModal<string> {
  private classes: string[];
  private file: TFile;

  constructor(app: App, classes: string[], file: TFile) {
    super(app);
    this.classes = classes;
    this.file = file;
    this.setPlaceholder(`Font for "${file.basename}"`);
  }

  getItems(): string[] { return this.classes; }
  getItemText(cls: string): string { return label(cls); }

  onChooseItem(cls: string): void {
    void applyFontToNote(this.app, this.file, this.classes, cls);
  }
}

/**
 * Write the choice into the note's frontmatter.
 *
 * Only ever removes font classes it knows about, so a note carrying somebody
 * else's cssclasses keeps them. And it drops the key entirely when the list
 * empties, rather than leaving `cssclasses: []` behind as litter.
 */
export async function applyFontToNote(
  app: App,
  file: TFile,
  known: string[],
  chosen: string,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const raw = fm.cssclasses;
    const current: string[] = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'string' && raw.trim()
        ? [raw.trim()]
        : [];

    const kept = current.filter((c) => !known.includes(c));
    // `default` means "no per-note font", so it adds nothing.
    const next = chosen === 'n2o-font-default' ? kept : [...kept, chosen];

    if (next.length) fm.cssclasses = next;
    else delete fm.cssclasses;
  });

  new Notice(chosen === 'n2o-font-default'
    ? `${file.basename}: back to the vault font.`
    : `${file.basename}: ${label(chosen)}.`);
}
