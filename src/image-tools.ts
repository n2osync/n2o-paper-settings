/**
 * The picture menu: right-click a picture in reading view or live preview for
 * its size, resize rows, file operations and the theme's flags. In live
 * preview Obsidian builds its own image menu; these rows join that same menu
 * (Menu.forEvent) and leave out what Obsidian already offers.
 *
 * Every resize is a number written into the embed. Nothing touches the file's bytes.
 */
import {
  ConfirmationModal,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Setting,
  TFile,
  normalizePath,
  type App,
  type Plugin,
  type WorkspaceWindow,
} from 'obsidian';
import { partsOf, withWidth } from './embed-flags';
import { protectedRanges, isProtected } from './markdown-ranges';
import {
  scanImageRefs,
  findRef,
  refWithWidth,
  sameVaultPath,
  sameUrl,
  isExternal,
  type ImageRef,
} from './image-links';

/** What the user can turn off. Every row is optional except the resizes. */
export interface ImageToolSettings {
  showFileInfo: boolean;
  showCopyImage: boolean;
  showCopyPath: boolean;
  showRename: boolean;
  showDelete: boolean;
  showOpenInNewTab: boolean;
  showOpenToRight: boolean;
  showOpenInNewWindow: boolean;
  showOpenInDefaultApp: boolean;
  showInSystemExplorer: boolean;
  /** Comma separated, each either `50%` or `600px`. Order is menu order. */
  customSizes: string;
  confirmDelete: boolean;
  /** What a ctrl or cmd click on a picture does. */
  clickAction: 'nothing' | 'new-tab' | 'default-app';
  wheelResize: boolean;
  wheelModifier: 'alt' | 'ctrl' | 'shift';
  /** Percent of the CURRENT width one notch changes it by. */
  wheelStep: number;
  wheelInvert: boolean;
}

export const DEFAULT_IMAGE_TOOLS: ImageToolSettings = {
  showFileInfo: true,
  showCopyImage: true,
  showCopyPath: true,
  showRename: true,
  showDelete: true,
  showOpenInNewTab: true,
  showOpenToRight: true,
  showOpenInNewWindow: true,
  showOpenInDefaultApp: true,
  showInSystemExplorer: true,
  customSizes: '50%, 75%, 150%',
  confirmDelete: true,
  clickAction: 'nothing',
  wheelResize: true,
  wheelModifier: 'alt',
  wheelStep: 20,
  wheelInvert: false,
};

/** One parsed entry from `customSizes`. */
export interface SizeOption {
  label: string;
  /** Percent of the current width, or null when `px` is set. */
  percent: number | null;
  px: number | null;
}

/**
 * Read the sizes list. An unparseable entry is DROPPED rather than guessed at,
 * because a typo becoming a 0px picture is worse than a missing menu row.
 */
export function parseSizes(raw: string): SizeOption[] {
  const out: SizeOption[] = [];
  for (const piece of raw.split(',')) {
    const t = piece.trim();
    if (!t) continue;
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
    if (pct) {
      const n = Number(pct[1]);
      if (n > 0) out.push({ label: `Resize to ${pct[1]}%`, percent: n, px: null });
      continue;
    }
    const px = /^(\d+)\s*(?:px)?$/i.exec(t);
    if (px) {
      const n = Number(px[1]);
      if (n > 0) out.push({ label: `Resize to ${n}px`, percent: null, px: n });
    }
  }
  return out;
}

/** A one-field prompt. Obsidian ships no inline text prompt. */
class TextPromptModal extends Modal {
  private value: string;
  constructor(
    app: App,
    private readonly heading: string,
    private readonly label: string,
    initial: string,
    private readonly onDone: (v: string) => void,
  ) {
    super(app);
    this.value = initial;
  }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    new Setting(this.contentEl).setName(this.label).addText((t) => {
      t.setValue(this.value).onChange((v) => {
        this.value = v;
      });
      t.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commit();
        }
      });
      window.setTimeout(() => {
        t.inputEl.focus();
        t.inputEl.select();
      }, 0);
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText('Save').setCta().onClick(() => this.commit()),
    );
  }
  private commit(): void {
    this.onDone(this.value);
    this.close();
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Obsidian exposes both of these on `app` at runtime and declares neither in
 * its types, so they are reached through a narrow local shape rather than a
 * cast to `any`. If a future version drops one, the caller says so out loud
 * instead of failing silently.
 */
interface DesktopApp {
  openWithDefaultApp?: (path: string) => void;
  showInFolder?: (path: string) => void;
}

/** The absolute path, or null on a vault that is not on a real filesystem. */
function fullPathOf(app: App, file: TFile): string | null {
  const adapter = app.vault.adapter as { getFullPath?: (p: string) => string };
  if (typeof adapter.getFullPath !== 'function') return null;
  return adapter.getFullPath(normalizePath(file.path));
}

/**
 * The reference in the note's text that produced THIS picture.
 *
 * Understands both syntaxes and external URLs, skips anything inside code, and
 * counts occurrences so the second copy of one picture is reachable. Exported
 * because `image-menu.ts` needs the same lookup for the theme's flag rows.
 */
export function findEmbed(
  text: string,
  linkText: string,
  occurrence: number,
): { start: number; end: number; inner: string; kind: ImageRef['kind']; ref: ImageRef } | null {
  const ref = findRef(refsIn(text), refMatcher(linkText), occurrence);
  return ref ? { start: ref.start, end: ref.end, inner: ref.inner, kind: ref.kind, ref } : null;
}

/** Which copy of `linkText` sits at (or nearest to) text offset `pos`. */
export function occurrenceAt(text: string, linkText: string, pos: number): number {
  const matches = refsIn(text).filter(refMatcher(linkText));
  let best = 0;
  let bestDist = Infinity;
  matches.forEach((r, i) => {
    const d = pos < r.start ? r.start - pos : pos > r.end ? pos - r.end : 0;
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

function refsIn(text: string): ImageRef[] {
  const off = protectedRanges(text);
  return scanImageRefs(text, (i) => isProtected(off, i));
}

function refMatcher(linkText: string): (r: ImageRef) => boolean {
  const external = isExternal(linkText);
  return (r) =>
    external
      ? isExternal(r.dest) && sameUrl(r.dest, linkText)
      : !isExternal(r.dest) && sameVaultPath(r.dest, linkText);
}

/** Everything the menu needs to know about the picture that was clicked. */
export interface Target {
  file: TFile | null;
  /** True when this picture belongs to a note transcluded into this one. */
  transcluded: boolean;
  /** The external URL when the picture lives outside the vault, else null. */
  url: string | null;
  linkText: string;
  occurrence: number;
  noteFile: TFile | null;
  el: HTMLImageElement;
}

/** Resolve an `app://` image source back to the vault file it came from. */
function fileForAppSrc(app: App, src: string): TFile | null {
  const files = app.vault.getFiles();
  /* Query and fragment are URL noise, not part of the vault path, so they are
   * removed before decoding. A file whose name contains an encoded `#` must
   * survive decoding as part of the path. */
  const rawPath = src.replace(/[?#].*$/, '');
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    /* A malformed percent escape still leaves the raw path usable for the
     * decoded path comparison below. */
  }
  /* The app URL carries the vault path after its host. Matching the decoded
   * path covers the gap between URL encoding and the plain vault path, and
   * Windows backslashes are folded into the forward slashes vault paths use. */
  const path = decoded.replace(/^app:\/\/[^/]+\//i, '').replace(/\\/g, '/');
  for (const file of files) {
    const resourcePath = app.vault.getResourcePath(file);
    if (resourcePath === src || resourcePath.replace(/[?#].*$/, '') === rawPath) return file;
  }
  for (const file of files) {
    if (path && sameVaultPath(path, file.path)) return file;
  }
  return null;
}

/** Which copy of the picture was clicked, counting rendered images of both syntaxes in document order. */
function occurrenceIn(
  el: HTMLImageElement,
  key: string,
): number {
  const scope = el.closest('.markdown-preview-view, .markdown-source-view') ?? el.ownerDocument;
  /* Compare by destination, never by the whole link text, which carries the width. */
  const all = Array.from(scope.querySelectorAll('img')).filter((n) => {
    const k = domKeyOf(n);
    return k !== null && sameVaultPath(k, key);
  });
  return Math.max(0, all.indexOf(el));
}

/**
 * The key a rendered image is matched on, or null when it is not one of ours.
 *
 * A wiki embed carries its link text on the `.internal-embed` wrapper; a
 * markdown image carries a resolved URL on the image itself.
 */
function domKeyOf(node: Element): string | null {
  const wrap = node.closest('.internal-embed');
  if (wrap) {
    const src = wrap.getAttribute('src');
    return src ? partsOf(src).path : null;
  }
  const raw = node.getAttribute('src');
  if (!raw) return null;
  if (isExternal(raw)) return raw;
  /* An app:// URL ends in the vault path, percent encoded. The tail is what
   * `sameVaultPath` compares, so the origin and the query are not in the way. */
  try {
    return decodeURIComponent(raw.replace(/^app:[/][/][^/]*[/]/, '').replace(/[?#].*$/, ''));
  } catch {
    return raw;
  }
}

/**
 * True when this image came from a DIFFERENT note transcluded into this one.
 *
 * `![[some note]]` renders that note's pictures inside this one. They are not
 * in this note's text, so counting them here and rewriting by that count edits
 * whichever of THIS note's pictures happens to sit at the same index. The
 * picture is real and file operations on it are fine; only the rewrites have
 * nowhere valid to land.
 */
function isTranscluded(el: HTMLImageElement): boolean {
  return el.closest('.markdown-embed-content, .markdown-embed') !== null;
}

/** The markdown view that holds this element, found by containment so a background pane resolves to its own note. */
function viewFor(app: App, el: HTMLElement): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view as MarkdownView;
    if (view.containerEl.contains(el)) return view;
  }
  return null;
}

function noteFileForEl(app: App, el: HTMLElement): TFile | null {
  const view = viewFor(app, el);
  return view ? view.file : app.workspace.getActiveFile();
}

/**
 * Which copy of the picture was clicked. Live preview keeps only the lines near
 * the viewport in the DOM, so there the editor position decides; reading view
 * counts the rendered images.
 */
function occurrenceOf(app: App, el: HTMLImageElement, key: string, linkText: string): number {
  const view = viewFor(app, el);
  const cm = (view?.editor as unknown as { cm?: { posAtDOM(node: Node): number } } | undefined)?.cm;
  if (view && cm && el.closest('.markdown-source-view')) {
    try {
      return occurrenceAt(view.editor.getValue(), linkText, cm.posAtDOM(el));
    } catch {
      /* not in the editor's document; count the DOM instead */
    }
  }
  return occurrenceIn(el, key);
}

function targetFrom(app: App, ev: MouseEvent): Target | null {
  const node = ev.target as HTMLElement | null;
  /* A pop-out window's image belongs to another DOM, so `instanceof
   * HTMLImageElement` fails there even though the element is an image. The tag
   * name works across window boundaries. */
  if (!node || node.tagName !== 'IMG') return null;
  const el = node as HTMLImageElement;
  const noteFile = noteFileForEl(app, el);

  const embedEl = el.closest<HTMLElement>('.internal-embed');
  if (embedEl) {
    const linkText = embedEl.getAttribute('src');
    if (!linkText) return null;

    const file = app.metadataCache.getFirstLinkpathDest(
      partsOf(linkText).path,
      noteFile?.path ?? '',
    );
    if (!file) return null;

    const occurrence = occurrenceOf(app, el, partsOf(linkText).path, linkText);
    return { file, linkText, occurrence, noteFile, el, url: null, transcluded: isTranscluded(el) };
  }

  const rawSrc = el.getAttribute('src');
  if (!rawSrc) return null;
  const src = rawSrc.trim();
  if (!src) return null;

  if (isExternal(src)) {
    /* There is no vault file behind an external picture, but the URL is enough
     * for `findEmbed` to match the markdown reference that produced it. */
    const linkText = src;
    const occurrence = occurrenceOf(app, el, domKeyOf(el) ?? src, linkText);
    return {
      file: null,
      linkText,
      occurrence,
      noteFile,
      el,
      url: src,
      transcluded: isTranscluded(el),
    };
  }

  if (src.toLowerCase().startsWith('app://')) {
    const file = fileForAppSrc(app, src);
    if (!file) return null;
    /* The file path is what the markdown destination was written as, so
     * `findEmbed` can match it through `sameVaultPath`. */
    const linkText = file.path;
    const occurrence = occurrenceOf(app, el, domKeyOf(el) ?? src, linkText);
    return { file, linkText, occurrence, noteFile, el, url: null, transcluded: isTranscluded(el) };
  }

  return null;
}

/**
 * Rewrite one note atomically. `rewrite` gets the current text and returns the
 * new text, or null when it found nothing to change.
 */
export async function updateNote(
  app: App,
  file: TFile,
  rewrite: (text: string) => string | null,
): Promise<boolean> {
  let found = false;
  await app.vault.process(file, (text) => {
    const next = rewrite(text);
    if (next === null) return text;
    found = true;
    return next;
  });
  return found;
}

/** Rewrite the reference that produced this picture, through the vault. */
async function rewriteRef(app: App, t: Target, width: number | null): Promise<boolean> {
  if (!t.noteFile) return false;
  return updateNote(app, t.noteFile, (text) => {
    const found = findEmbed(text, t.linkText, t.occurrence);
    if (!found) return null;
    /* Each syntax keeps its own shape. `withWidth` owns the wiki grammar and is
     * handed in rather than reimplemented here, so there is one definition of
     * what a wiki embed looks like. */
    return (
      text.slice(0, found.start) +
      refWithWidth(found.ref, width, (inner, w) => withWidth(inner, w)) +
      text.slice(found.end)
    );
  });
}

async function applyWidth(app: App, t: Target, width: number | null): Promise<void> {
  /* The text of a transcluded picture lives in the OTHER note, so there is
   * nothing here to rewrite and a count taken from this note's DOM would land
   * on one of this note's own pictures. Say so rather than editing the wrong
   * line. */
  if (t.transcluded) {
    new Notice(
      'That picture comes from a note embedded in this one, so its size is set in that note.',
    );
    return;
  }
  const ok = await rewriteRef(app, t, width);
  if (!ok) {
    new Notice(
      `Could not find "${t.linkText}" in this note, so its size was not changed. ` +
        'This happens when the picture comes from an embedded note rather than this one.',
    );
  }
}

/** The width a size row asks for: fixed pixels, or a percent of the width on screen now. */
function widthFor(t: Target, opt: SizeOption): number | null {
  if (opt.px !== null) return opt.px;
  const current = t.el.clientWidth || t.el.naturalWidth;
  if (!current) {
    new Notice('Could not read the size of that picture, so a percentage cannot be worked out.');
    return null;
  }
  return Math.max(16, Math.round((current * (opt.percent ?? 100)) / 100));
}

async function copyImageToClipboard(app: App, file: TFile): Promise<void> {
  try {
    const bytes = await app.vault.readBinary(file);
    /* Everything goes to the clipboard as PNG. It is the one image type every
     * target accepts, and a JPEG blob labelled image/png is refused outright.
     * The canvas round trip is what performs the conversion. */
    const blob = new Blob([bytes], { type: `image/${file.extension.toLowerCase()}` });
    const bitmap = await createImageBitmap(blob);
    const canvas = createEl('canvas', { attr: { width: bitmap.width, height: bitmap.height } });
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!png) throw new Error('the picture could not be re-encoded for the clipboard');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    new Notice(`Copied "${file.name}"`);
  } catch (err) {
    new Notice(
      `Could not copy "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function openIn(app: App, file: TFile, where: 'tab' | 'split' | 'window'): void {
  const leaf = app.workspace.getLeaf(where);
  void leaf.openFile(file);
}

function explorerLabel(): string {
  if (Platform.isMacOS) return 'Show in Finder';
  if (Platform.isLinux) return 'Show in file manager';
  return 'Show in Explorer';
}

/**
 * Remove the embed from this note, then trash the file only when no other note
 * links to it (checked through metadataCache.resolvedLinks). Nothing is
 * trashed when the embed cannot be found.
 */
async function deleteImageAndLink(app: App, file: TFile, t: Target): Promise<void> {
  try {
    let removed = false;
    if (t.noteFile && !t.transcluded) {
      removed = await updateNote(app, t.noteFile, (text) => {
        const found = findEmbed(text, t.linkText, t.occurrence);
        if (!found) return null;
        return text.slice(0, found.start) + text.slice(found.end);
      });
    }

    if (!removed) {
      new Notice(
        `Could not find the link to "${file.name}" in this note, so nothing was deleted. ` +
          'The picture may come from a note embedded in this one.',
      );
      return;
    }

    /* Who else points at this file? The resolved-links map is keyed by source
     * note, so this asks every note except the one just edited. */
    const others: string[] = [];
    const links = app.metadataCache.resolvedLinks;
    for (const [from, targets] of Object.entries(links)) {
      if (from === t.noteFile?.path) continue;
      if (targets[file.path]) others.push(from);
    }

    if (others.length) {
      const names = others.slice(0, 3).join(', ');
      const more = others.length > 3 ? ` and ${others.length - 3} more` : '';
      new Notice(
        `Removed the link. "${file.name}" was kept because ${others.length} other note(s) ` +
          `still use it: ${names}${more}.`,
      );
      return;
    }

    /* trashFile, not delete: it honours whatever the user chose under Files
     * and links, so somebody on system trash can get the picture back. */
    await app.fileManager.trashFile(file);
    new Notice(`Deleted "${file.name}"`);
  } catch (err) {
    new Notice(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The quoted title part of a markdown destination, with its leading space. */
function markdownTitleOf(dest: string): string {
  const titled = /^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/.exec(dest);
  return titled ? titled[2] ?? '' : '';
}

/** Replace the file-name part of a wiki destination, keeping any folder prefix
 * and any heading or block suffix. */
function replaceWikiDestName(dest: string, newName: string): string {
  const m = /^([^#^]*)([#^].*)?$/.exec(dest);
  const path = m ? m[1] : dest;
  const suffix = m && m[2] ? m[2] : '';
  const slash = path.lastIndexOf('/');
  const prefix = slash === -1 ? '' : path.slice(0, slash + 1);
  return prefix + newName + suffix;
}

/** Percent-encode one markdown path segment, including the few characters
 * `encodeURIComponent` leaves alone that can end a bare destination early. */
function encodeMarkdownSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/** Replace the file-name part of a markdown destination path, keeping the
 * written folder prefix and encoding the new name when it is not bracketed. */
function replaceMarkdownDestName(
  path: string,
  newName: string,
  bracketed: boolean | undefined,
): string {
  const slash = path.lastIndexOf('/');
  const prefix = slash === -1 ? '' : path.slice(0, slash + 1);
  return prefix + (bracketed ? newName : encodeMarkdownSegment(newName));
}

/** A full markdown destination path, encoded unless it is bracketed. */
function markdownDestForFullPath(path: string, bracketed: boolean | undefined): string {
  if (bracketed) return path;
  return path.split('/').map((part) => encodeMarkdownSegment(part)).join('/');
}

/** The directory part of a normalized vault path, '' at the vault root. */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * The whole reference rewritten with a NEW DESTINATION, keeping every other
 * part: wiki flags and width, markdown alt text, title and angle brackets.
 *
 * A same-directory rename keeps the destination as short as it was written; a
 * move to another directory has to write the full new path instead.
 */
function refWithDest(ref: ImageRef, oldPath: string, newPath: string): string {
  const newName = newPath.split('/').pop() ?? newPath;
  const sameDir = sameVaultPath(dirOf(oldPath), dirOf(newPath));

  if (ref.kind === 'wiki') {
    const parts = ref.inner.split('|');
    parts[0] = sameDir ? replaceWikiDestName(parts[0], newName) : newPath;
    return `![[${parts.join('|')}]]`;
  }

  const title = markdownTitleOf(ref.dest);
  const writtenPath = ref.dest.slice(0, ref.dest.length - title.length);
  const path = sameDir
    ? replaceMarkdownDestName(writtenPath, newName, ref.destBracketed)
    : markdownDestForFullPath(newPath, ref.destBracketed);
  return `![${ref.inner}](${ref.destBracketed ? `<${path}>${title}` : `${path}${title}`})`;
}

/** Every reference in `text` that points at `path`, protected ranges skipped. */
function refsTo(text: string, path: string): ImageRef[] {
  const ranges = protectedRanges(text);
  const refs = scanImageRefs(text, (i) => isProtected(ranges, i));
  const matches: ImageRef[] = [];
  let occurrence = 0;
  for (;;) {
    const ref = findRef(
      refs,
      (r) => !isExternal(r.dest) && sameVaultPath(r.dest, path),
      occurrence,
    );
    if (!ref) break;
    matches.push(ref);
    occurrence += 1;
  }
  return matches;
}

/**
 * Rewrite every reference that points at `oldPath`, leaving protected ranges
 * and every other reference alone. Returns null when nothing matched so the
 * caller can tell an untouched note from one it changed.
 */
function rewriteRefsTo(text: string, oldPath: string, newPath: string): string | null {
  const matches = refsTo(text, oldPath);
  if (matches.length === 0) return null;

  let out = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const ref = matches[i];
    out = out.slice(0, ref.start) + refWithDest(ref, oldPath, newPath) + out.slice(ref.end);
  }
  return out;
}

/** How many references in `text` point at `path`, protected ranges skipped. */
function countRefsTo(text: string, path: string): number {
  return refsTo(text, path).length;
}

/** Source note paths whose resolved links include `path`. */
function notesLinkingTo(app: App, path: string): string[] {
  const out: string[] = [];
  for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (targets[path]) out.push(source);
  }
  return out;
}

/** Poll for a vault file until it appears, or until the timeout is spent. */
async function waitForPath(app: App, path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.vault.getAbstractFileByPath(path) instanceof TFile) return true;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  return app.vault.getAbstractFileByPath(path) instanceof TFile;
}

async function renameImageAndUpdateLinks(
  app: App,
  file: TFile,
  next: string,
): Promise<void> {
  const oldPath = file.path;
  const oldName = file.name;
  const newName = next.split('/').pop() ?? next;

  /* A stale file at the destination would make the poll below report success
   * for a rename that never happened, so refuse that before starting. */
  const existing = app.vault.getAbstractFileByPath(next);
  if (existing && existing !== file) {
    new Notice(`Could not rename "${oldName}" because a file already exists at "${next}".`);
    return;
  }

  /* The notes that need an edit are known before the rename; after it,
   * Obsidian may have already rewritten them or the cache may already be keyed
   * by the new path. */
  const sources = notesLinkingTo(app, oldPath);

  /* renameFile can hang, so it is not awaited. The poll below is the source
   * of truth for whether the file actually moved. */
  /* An object, not a `let`: the compiler cannot see a callback assign a
   * local, so it would narrow a `let` to its initial null for good. */
  const rename: { error?: string } = {};
  void app.fileManager.renameFile(file, next).catch((err: unknown) => {
    rename.error = err instanceof Error ? err.message : String(err);
  });

  const moved = await waitForPath(app, next, 3000);
  if (!moved) {
    if (rename.error !== undefined) {
      new Notice(`Could not rename "${oldName}": ${rename.error}`);
    } else {
      new Notice(
        `Could not confirm that "${oldName}" was renamed to "${newName}", so no links were changed.`,
      );
    }
    return;
  }

  let updated = 0;
  let already = 0;
  let failed = 0;

  for (const sourcePath of sources) {
    const note = app.vault.getAbstractFileByPath(sourcePath);
    if (!(note instanceof TFile)) {
      failed += 1;
      continue;
    }
    try {
      const changed = await updateNote(app, note, (text) => rewriteRefsTo(text, oldPath, next));
      if (changed) {
        updated += 1;
        continue;
      }
      /* The note was recorded as linking to the old path. If our rewrite found
       * nothing, either Obsidian already rewrote it while renaming, or the
       * reference is in a form this scanner cannot see. Read it back to tell
       * those two apart rather than reporting a failure that did not happen. */
      const current = await app.vault.read(note);
      if (countRefsTo(current, next) > 0) {
        already += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      console.error('N2O Paper failed to update an image link after a rename', err);
    }
  }

  if (failed > 0) {
    const updatedPart = updated > 0 ? ` Updated ${updated} note(s), but` : '';
    new Notice(
      `Renamed "${oldName}" to "${newName}".${updatedPart} ` +
        `${failed} note(s) still point at the old name because their references were not found.`,
    );
  } else if (updated > 0) {
    const extra = already > 0 ? ` ${already} note(s) were already updated.` : '';
    new Notice(`Renamed "${oldName}" to "${newName}" and updated ${updated} note(s).${extra}`);
  } else if (already > 0) {
    new Notice(
      `Renamed "${oldName}" to "${newName}". The ${already} note(s) that linked to it were already updated.`,
    );
  } else {
    new Notice(`Renamed "${oldName}" to "${newName}". No notes referenced it.`);
  }
}

/**
 * Add the picture rows to `menu`. With `native` set, Obsidian's own image menu
 * is already in it, so only the rows it lacks are added: sizes and the extras.
 */
export function buildMenu(
  app: App,
  s: ImageToolSettings,
  t: Target,
  native: boolean,
  extras: ((menu: Menu, t: Target) => void)[],
  menu: Menu = new Menu(),
): Menu {
  const file = t.file;
  const full = file ? fullPathOf(app, file) : null;
  const desktop = app as unknown as DesktopApp;
  const { naturalWidth: w, naturalHeight: h } = t.el;

  if (!native) addFileRows(app, s, t, menu, file, full, w, h);

  const sizes = parseSizes(s.customSizes);
  if (sizes.length) {
    menu.addSeparator();
    for (const opt of sizes) {
      menu.addItem((i) =>
        i.setTitle(opt.label).setIcon('scaling').onClick(async () => {
          const width = widthFor(t, opt);
          if (width !== null) await applyWidth(app, t, width);
        }),
      );
    }
    menu.addItem((i) =>
      i.setTitle('Resize to...').setIcon('scaling').onClick(() => {
        new TextPromptModal(app, 'Resize', 'Width in pixels, or empty to clear it', '', (v) => {
          const raw = v.trim().replace(/px$/i, '');
          const n = Number(raw);
          void applyWidth(app, t, raw === '' ? null : Number.isFinite(n) && n > 0 ? n : null);
        }).open();
      }),
    );
  }
  if (!native && t.el.getAttribute('width')) {
    menu.addItem((i) =>
      i.setTitle('Remove custom size').onClick(() => void applyWidth(app, t, null)),
    );
  }
  if (!native) addOpenRows(app, s, t, menu, file, full, desktop);

  for (const add of extras) add(menu, t);
  return menu;
}

function addFileRows(
  app: App,
  s: ImageToolSettings,
  t: Target,
  menu: Menu,
  file: TFile | null,
  full: string | null,
  w: number,
  h: number,
): void {
  if (s.showFileInfo) {
    menu.addItem((i) => i.setTitle(file ? file.name : 'Remote image').setIsLabel(true));
    if (w > 0 && h > 0) menu.addItem((i) => i.setTitle(`${w} x ${h} px`).setIsLabel(true));
    menu.addSeparator();
  }

  /* Rows that operate on a vault file are meaningless for an external picture,
   * so each is offered only when the target resolved to a real file. */
  if (s.showCopyImage && file) {
    menu.addItem((i) =>
      i
        .setTitle('Copy image')
        .setIcon('image')
        .onClick(() => void copyImageToClipboard(app, file)),
    );
  }
  if (t.url) {
    const url = t.url;
    menu.addItem((i) =>
      i
        .setTitle('Copy image URL')
        .setIcon('link')
        .onClick(async () => {
          try {
            await navigator.clipboard.writeText(url);
            new Notice('Copied the image URL');
          } catch (err) {
            new Notice(
              `Could not copy the image URL: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }),
    );
  }
  if (s.showCopyPath && full) {
    menu.addItem((i) =>
      i
        .setTitle('Copy local path')
        .setIcon('clipboard')
        .onClick(() => {
          void navigator.clipboard.writeText(full);
          new Notice('Copied the path');
        }),
    );
  }

}

function addOpenRows(
  app: App,
  s: ImageToolSettings,
  t: Target,
  menu: Menu,
  file: TFile | null,
  full: string | null,
  desktop: DesktopApp,
): void {
  const opens =
    file !== null &&
    (s.showOpenInNewTab ||
      s.showOpenToRight ||
      s.showOpenInNewWindow ||
      s.showOpenInDefaultApp);
  if (opens) menu.addSeparator();
  if (s.showOpenInNewTab && file) {
    menu.addItem((i) => i.setTitle('Open in new tab').onClick(() => openIn(app, file, 'tab')));
  }
  if (s.showOpenToRight && file) {
    menu.addItem((i) => i.setTitle('Open to the right').onClick(() => openIn(app, file, 'split')));
  }
  if (s.showOpenInNewWindow && file) {
    menu.addItem((i) =>
      i.setTitle('Open in new window').onClick(() => openIn(app, file, 'window')),
    );
  }
  if (s.showOpenInDefaultApp && file && full) {
    menu.addItem((i) =>
      i.setTitle('Open in default app').onClick(() => {
        if (typeof desktop.openWithDefaultApp === 'function') {
          desktop.openWithDefaultApp(file.path);
        } else {
          new Notice('This build of Obsidian cannot open a file in its default app.');
        }
      }),
    );
  }

  if (s.showInSystemExplorer && file && full) {
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(explorerLabel()).onClick(() => {
        if (typeof desktop.showInFolder === 'function') desktop.showInFolder(file.path);
        else new Notice('This build of Obsidian cannot reveal a file in the file manager.');
      }),
    );
  }

  if (s.showRename && file) {
    menu.addItem((i) =>
      i
        .setTitle('Rename image')
        .setIcon('pencil')
        .onClick(() => {
          new TextPromptModal(app, 'Rename image', 'New file name', file.name, (v) => {
            const name = v.trim();
            if (!name || name === file.name) return;
            const parent = file.parent?.path ?? '';
            const next = normalizePath(parent ? `${parent}/${name}` : name);
            /* renameFile moves the file, and may or may not rewrite links
             * depending on a vault setting. A picture with broken links is
             * broken no matter how that setting is set, so the links are
             * rewritten here after the new path is known to exist. */
            void renameImageAndUpdateLinks(app, file, next);
          }).open();
        }),
    );
  }

  if (s.showDelete && file) {
    menu.addItem((i) =>
      i
        .setTitle('Delete image and link')
        .setIcon('trash')
        .onClick(() => {
          const run = (): void => void deleteImageAndLink(app, file, t);
          if (!s.confirmDelete) {
            run();
            return;
          }
          const modal = new ConfirmationModal(app).addClass('n2o-ps-modal');
          modal.setTitle('Delete image and link');
          modal.setContent(`"${file.name}" will go to your configured trash, and the embed will be removed from this note.`);
          modal.addCancelButton();
          modal.addButton((b) => b.setButtonText('Delete').setDestructive().onClick(run));
          modal.open();
        }),
    );
  }

}

function modifierHeld(
  ev: MouseEvent | WheelEvent,
  which: ImageToolSettings['wheelModifier'],
): boolean {
  if (which === 'alt') return ev.altKey;
  if (which === 'ctrl') return ev.ctrlKey || ev.metaKey;
  return ev.shiftKey;
}

/**
 * Wire the picture menu, the modifier click and the wheel resize.
 *
 * `extras` lets the theme's own flag rows join this menu rather than opening a
 * second one, so a right-click on a picture is one menu and not two.
 */
export function registerImageTools(
  plugin: Plugin,
  read: () => ImageToolSettings,
  extras: ((menu: Menu, t: Target) => void)[] = [],
): void {
  const app = plugin.app;
  /* Timers stay in the main window so a gesture can be committed no matter
   * which window the wheel event came from. */
  const mainWindow = window;

  // One write per wheel gesture: the width is tracked in memory and shown
  // through the picture's style, and the note is written once the wheel stops.
  let pendingWidth: number | null = null;
  let pendingTarget: Target | null = null;
  let settle = 0;
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueWrite = (task: () => Promise<void>): void => {
    /* A failed write must not wedge every write that follows it. */
    writeQueue = writeQueue.then(task, task).catch((err: unknown) => {
      console.error('N2O Paper failed to write an image width', err);
    });
  };

  const commit = (): void => {
    const t = pendingTarget;
    const w = pendingWidth;
    pendingTarget = null;
    pendingWidth = null;
    if (t && w !== null) {
      t.el.style.removeProperty('width');
      enqueueWrite(() => applyWidth(app, t, w));
    }
  };

  const windowCleanups = new Map<Window, () => void>();
  const handled = new WeakSet<Event>();
  /** Right-clicks on a reading-view picture that this menu claimed before Obsidian saw them. */
  const claimed = new WeakSet<Event>();

  const wire = (win: Window): void => {
    const onContextMenu = (ev: MouseEvent): void => {
      // A pop-out window can deliver the same event twice; one menu per event.
      if (handled.has(ev)) return;
      const t = targetFrom(app, ev);
      if (!t) return;
      handled.add(ev);
      // Obsidian's live-preview image menu claims the event first; join it.
      buildMenu(app, read(), t, ev.defaultPrevented && !claimed.has(ev), extras, Menu.forEvent(ev));
    };

    // Reading view opens its image lightbox on contextmenu unless the event is
    // already defaultPrevented, so a right-click our menu answers is marked first.
    const onContextMenuCapture = (ev: MouseEvent): void => {
      const node = ev.target as HTMLElement | null;
      if (node?.tagName !== 'IMG' || !node.closest('.markdown-preview-view') || !targetFrom(app, ev)) return;
      ev.preventDefault();
      claimed.add(ev);
    };

    const onClick = (ev: MouseEvent): void => {
      const s = read();
      if (s.clickAction === 'nothing') return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const t = targetFrom(app, ev);
      if (!t || !t.file) return;
      const file = t.file;
      ev.preventDefault();
      if (s.clickAction === 'new-tab') {
        openIn(app, file, 'tab');
      } else {
        (app as unknown as DesktopApp).openWithDefaultApp?.(file.path);
      }
    };

    /* Not passive: a wheel that resizes must stop the pane scrolling under it,
     * and a passive listener cannot. The guards run before preventDefault, so
     * an ordinary scroll over a picture is untouched. */
    const onWheel = (ev: WheelEvent): void => {
      const s = read();
      if (!s.wheelResize || !modifierHeld(ev, s.wheelModifier)) return;
      const t = targetFrom(app, ev);
      if (!t) return;
      ev.preventDefault();

      /* A gesture that moves to a different picture commits the first one
       * rather than dropping it. */
      if (pendingTarget && pendingTarget.el !== t.el) {
        mainWindow.clearTimeout(settle);
        commit();
      }

      const base = pendingWidth ?? t.el.clientWidth ?? t.el.naturalWidth;
      if (!base) return;
      const up = s.wheelInvert ? ev.deltaY > 0 : ev.deltaY < 0;
      const step = Math.max(1, Math.round((base * s.wheelStep) / 100));
      const next = Math.max(16, base + (up ? step : -step));

      pendingTarget = t;
      pendingWidth = next;
      /* Immediate feedback without touching the file. Removed by commit, so
       * the rendered width comes back from the embed and nothing is left
       * styled inline. */
      t.el.style.width = `${next}px`;

      mainWindow.clearTimeout(settle);
      settle = mainWindow.setTimeout(commit, 400);
    };

    const cleanup = (): void => {
      win.removeEventListener('contextmenu', onContextMenu);
      win.removeEventListener('contextmenu', onContextMenuCapture, true);
      win.removeEventListener('click', onClick);
      win.removeEventListener('wheel', onWheel);
    };

    const previous = windowCleanups.get(win);
    if (previous) previous();
    windowCleanups.set(win, cleanup);

    win.addEventListener('contextmenu', onContextMenu);
    win.addEventListener('contextmenu', onContextMenuCapture, true);
    win.addEventListener('click', onClick);
    win.addEventListener('wheel', onWheel, { passive: false });
  };

  wire(mainWindow);

  /* Pop-out windows have their own documents, so listeners on the main
   * document never see a picture opened in one. Wire each window as it opens,
   * release its listeners as soon as it closes, and commit a gesture on the
   * window that is going away. */
  plugin.registerEvent(
    app.workspace.on('window-open', (win: WorkspaceWindow) => {
      wire(win.win);
    }),
  );
  plugin.registerEvent(
    app.workspace.on('window-close', (win: WorkspaceWindow) => {
      /* Only a gesture on the closing window needs to be committed; one in
       * another window is still waiting for its own wheel to stop. */
      if (pendingTarget && pendingTarget.el.ownerDocument.defaultView === win.win) {
        mainWindow.clearTimeout(settle);
        commit();
      }
      const cleanup = windowCleanups.get(win.win);
      if (cleanup) {
        cleanup();
        windowCleanups.delete(win.win);
      }
    }),
  );

  /* A pane closed mid-gesture would otherwise leave the last notch unwritten,
   * and every listener must go away when the plugin unloads. */
  plugin.register(() => {
    mainWindow.clearTimeout(settle);
    commit();
    for (const cleanup of windowCleanups.values()) cleanup();
    windowCleanups.clear();
  });
}
