/**
 * Right-click a picture in the editor and set its flags there.
 *
 * ## The scenario
 *
 * The theme dresses every picture as a print: a warm white mount, a foot for
 * the caption, a lifted corner. Any one picture can opt out or change with a
 * flag written into the embed, `![[cabin.png|plain|A cabin in the pines]]`.
 * That is a good vocabulary and an awful interface: you have to know the seven
 * words exist, remember which order they go in, and type them without breaking
 * the caption or the width sitting in the same brackets.
 *
 * So the words get a menu. Right-click the embed, tick the flag, and the line
 * is rewritten for you.
 *
 * ## Editor only, deliberately
 *
 * `editor-menu` hands over the editor and the cursor, so the embed under the
 * pointer is known exactly. Reading view has no equivalent: you would catch a
 * DOM `contextmenu`, then map the node back to a line, which is a guess the
 * moment the same picture appears twice in one note. Flags are written while
 * writing, so the editor is where the menu belongs and reading view keeps no
 * half-working copy of it.
 */
import { Menu, Modal, Setting, type App, type Editor, type Plugin } from 'obsidian';
import {
  embedAt,
  partsOf,
  toggleFlag,
  withCaption,
} from './embed-flags';

/** The flags worth a menu row, in the order they are offered. */
const OFFERED: { flag: string; label: string }[] = [
  { flag: 'plain', label: 'No print mount' },
  { flag: 'aged', label: 'Aged print' },
  { flag: 'round', label: 'Round' },
  { flag: 'left', label: 'Float left' },
  { flag: 'right', label: 'Float right' },
];

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
      for (const { flag, label } of OFFERED) {
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
