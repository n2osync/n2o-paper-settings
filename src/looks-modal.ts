/** The look picker for the "Choose a look..." command, and the modal that saves, renames and deletes looks. */
import { FuzzySuggestModal, Modal, Notice, Setting } from 'obsidian';
import type { Look } from './looks';
import type N2OPaperSettingsPlugin from './main';

export class LookPicker extends FuzzySuggestModal<Look> {
  constructor(private readonly plugin: N2OPaperSettingsPlugin) {
    super(plugin.app);
    this.setPlaceholder('Choose a look');
  }
  getItems(): Look[] { return this.plugin.looks(); }
  getItemText(look: Look): string { return look.builtIn ? look.title : `${look.title} (saved)`; }
  onChooseItem(look: Look): void { void this.plugin.applyLook(look); }
}

export class LooksModal extends Modal {
  private name = '';

  constructor(private readonly plugin: N2OPaperSettingsPlugin, private readonly onChange: () => void) {
    super(plugin.app);
  }

  onOpen(): void {
    this.setTitle('Your looks');
    this.draw();
  }

  private draw(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName('Save current look')
      .setDesc('Keeps every value you have changed under a name.')
      .addText((t) => t.setPlaceholder('Name').setValue(this.name).onChange((v) => { this.name = v; }))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(() => void this.save()));

    for (const look of this.plugin.savedLooks) {
      new Setting(contentEl)
        .addText((t) => t.setValue(look.title).onChange((v) => {
          if (!v.trim()) return;
          look.title = v.trim();
          void this.plugin.persist().then(this.onChange);
        }))
        .addExtraButton((b) => b.setIcon('trash').setTooltip('Delete').onClick(() => {
          this.plugin.savedLooks = this.plugin.savedLooks.filter((l) => l !== look);
          void this.plugin.persist().then(() => { this.onChange(); this.draw(); });
        }));
    }
  }

  private async save(): Promise<void> {
    const title = this.name.trim();
    if (!title) {
      new Notice('Give the look a name.');
      return;
    }
    await this.plugin.saveLook(title);
    this.name = '';
    this.onChange();
    this.draw();
    new Notice(`Saved "${title}".`);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
