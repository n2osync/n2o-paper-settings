/**
 * The theme's picture flags (`![[cabin.png|plain|A caption]]`) as menu rows:
 * in the editor's own menu when the cursor is on an embed, and as extra rows in
 * the picture menu (`image-tools.ts`) when the picture itself is right-clicked.
 */
import { Modal, Setting, type App, type Editor, type Menu, type Plugin, type TFile } from 'obsidian';
import {
  embedAt,
  partsOf,
  toggleFlag,
  withCaption,
} from './embed-flags';
import { findEmbed, updateNote } from './image-tools';
import { PICTURE_FLAGS } from './actions';


/** A one-field prompt, because Obsidian ships no inline text prompt. */
class CaptionModal extends Modal {
  private value: string;
  constructor(app: App, initial: string, private readonly onDone: (v: string) => void) {
    super(app);
    this.value = initial;
  }
  onOpen(): void {
    this.titleEl.setText('Caption');
    new Setting(this.contentEl)
      .setName('Written on the foot of the print')
      .setDesc('Leave it empty to remove the caption.')
      .addText((t) => {
        t.setValue(this.value).onChange((v) => { this.value = v; });
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.commit(); }
        });
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText('Save').setCta().onClick(() => this.commit()));
  }
  private commit(): void { this.onDone(this.value); this.close(); }
  onClose(): void { this.contentEl.empty(); }
}

/** Wire the menu onto the editor. */
export function registerImageMenu(plugin: Plugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      const embed = embedAt(line, cursor.ch);
      if (!embed) return;

      const from = { line: cursor.line, ch: embed.start };
      const to = { line: cursor.line, ch: embed.end };
      const rewrite = (next: string) => editor.replaceRange(next, from, to);
      const current = partsOf(embed.inner);

      menu.addSeparator();
      for (const { flag, label } of PICTURE_FLAGS) {
        menu.addItem((item) => item
          .setTitle(label)
          .setChecked(current.flags.includes(flag))
          .onClick(() => rewrite(toggleFlag(embed.inner, flag))));
      }
      menu.addItem((item) => item
        .setTitle(current.caption ? 'Edit caption...' : 'Add caption...')
        .setIcon('text-cursor-input')
        .onClick(() => {
          new CaptionModal(plugin.app, current.caption ?? '', (v) =>
            rewrite(withCaption(embed.inner, v))).open();
        }));
    }),
  );
}

/** The flags already on a rendered picture: the wrapper's alt for a wiki embed, the image's alt otherwise. */
function flagsOn(el: HTMLImageElement): string[] {
  const alt = el.closest('.internal-embed')?.getAttribute('alt') ?? el.getAttribute('alt') ?? '';
  return partsOf(`x|${alt}`).flags;
}

/** The flag rows for the picture menu, ticked when set, written back through the vault. */
export function flagRowsFor(app: App) {
  return (menu: Menu, t: { linkText: string; occurrence: number; noteFile: TFile | null; transcluded: boolean; el: HTMLImageElement }): void => {
    const note = t.noteFile;
    if (!note || t.transcluded) return;
    const set = flagsOn(t.el);
    menu.addSeparator();
    for (const { flag, label } of PICTURE_FLAGS) {
      menu.addItem((item) =>
        item.setTitle(label).setChecked(set.includes(flag)).onClick(() => {
          void updateNote(app, note, (text) => {
            const found = findEmbed(text, t.linkText, t.occurrence);
            if (!found) return null;
            return text.slice(0, found.start) + toggleFlag(found.inner, flag) + text.slice(found.end);
          });
        }),
      );
    }
  };
}
