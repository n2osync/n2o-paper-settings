/**
 * Everything you can do to a picture by right-clicking it.
 *
 * ## The scenario
 *
 * A picture in a note is a file on disk, and every ordinary thing you want to
 * do with a file, see how big it is, make it smaller, copy it, rename it, open
 * it somewhere else, means leaving Obsidian to go and find it. The width is the
 * one people fight: `![[cabin.png]]` renders at whatever the camera produced,
 * and fixing that means knowing the embed takes `|500` and typing it by hand
 * for every picture.
 *
 * So the file gets a menu, on the picture itself, in reading view and in live
 * preview alike.
 *
 * ## Why this hooks the DOM and `image-menu.ts` hooks the editor
 *
 * They answer different questions. `editor-menu` fires for the TEXT under the
 * cursor and hands over the editor, which is right for the theme's flags: those
 * are written while writing. It does not fire on the rendered picture, because
 * that is a widget rather than text.
 *
 * This one starts from the rendered picture, so it works where the picture is,
 * and finds the line afterwards. `.internal-embed` carries the link text in its
 * own `src` attribute, which is how the file is resolved without parsing an
 * `app://` URL. The same picture can appear twice in one note, so the line is
 * found by counting which occurrence was clicked rather than by taking the
 * first match. That was the objection that kept reading view out of the flags
 * menu, and counting is the answer to it.
 *
 * ## What is deliberately NOT here
 *
 * Nothing writes to a picture's bytes. Every resize is a number in the embed,
 * so it is reversible, costs nothing, and leaves the original alone. A plugin
 * that re-encodes somebody's photograph to save a few hundred kilobytes is a
 * plugin that eventually ruins one.
 */
import {
  MarkdownView,
  Menu,
  Modal,
  Notice,
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
  altParts,
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
  customSizes: '25%, 50%, 100%',
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
  /** Percent of natural width, or null when `px` is set. */
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

/** A yes or no, used only where the answer destroys something. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly body: string,
    private readonly onYes: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Delete')
          .setWarning()
          .onClick(() => {
            this.onYes();
            this.close();
          }),
      );
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

/**
 * The atomic note rewrite Obsidian ships as `vault.process`. The installed
 * typings may not declare it, so it is reached through the same narrow shape
 * as the desktop-only methods above and checked before use.
 */
interface ProcessVault {
  process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
}

/** The absolute path, or null on a vault that is not on a real filesystem. */
function fullPathOf(app: App, file: TFile): string | null {
  const adapter = app.vault.adapter as { getFullPath?: (p: string) => string };
  if (typeof adapter.getFullPath !== 'function') return null;
  return adapter.getFullPath(normalizePath(file.path));
}

/** Natural pixel size, read off a decoded copy so a scaled embed cannot lie. */
async function naturalSizeOf(app: App, file: TFile): Promise<{ w: number; h: number } | null> {
  const url = app.vault.getResourcePath(file);
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => {
      /* SVG files often load with no intrinsic size, which the browser reports
       * as zero width even when the file itself declares one. */
      if (file.extension.toLowerCase() === 'svg' && probe.naturalWidth === 0) {
        void readSvgSize(app, file).then(resolve);
        return;
      }
      resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    };
    probe.onerror = () => resolve(null);
    probe.src = url;
  });
}

/** Read an SVG's declared size straight from its text. */
async function readSvgSize(app: App, file: TFile): Promise<{ w: number; h: number } | null> {
  try {
    const text = await app.vault.read(file);
    return svgSizeFrom(text);
  } catch {
    return null;
  }
}

/** Read one attribute off an SVG opening tag, quoted either way or unquoted. */
function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** A plain SVG length: a bare number, or the same number with a `px` unit. */
function pxValue(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(raw);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * The size declared on an SVG's root element. The explicit width and height
 * win when both are real lengths; otherwise the viewBox carries the same
 * information in its last two numbers. Percentages and relative units never
 * describe a pixel size, so they are left for the viewBox fallback.
 */
function svgSizeFrom(text: string): { w: number; h: number } | null {
  const root = /<svg\b[^>]*>/i.exec(text);
  if (!root) return null;
  const tag = root[0];

  const width = attrOf(tag, 'width');
  const height = attrOf(tag, 'height');
  const w = width === null ? null : pxValue(width);
  const h = height === null ? null : pxValue(height);
  if (w !== null && h !== null && w > 0 && h > 0) return { w, h };

  const viewBox = attrOf(tag, 'viewBox');
  if (!viewBox) return null;
  const nums = viewBox.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4) return null;
  const vbW = nums[2];
  const vbH = nums[3];
  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) return null;
  return { w: vbW, h: vbH };
}

/** Natural size of the target, from its file or from the rendered image. */
async function sizeFor(app: App, t: Target): Promise<{ w: number; h: number } | null> {
  if (t.file) return naturalSizeOf(app, t.file);
  /* An external picture has no vault file to probe, so the image the browser
   * already rendered is the only source of truth for its natural size. */
  if (t.el.naturalWidth > 0 && t.el.naturalHeight > 0) {
    return { w: t.el.naturalWidth, h: t.el.naturalHeight };
  }
  return null;
}

/**
 * The width already written on the reference that produced this picture. The
 * menu is built synchronously but reading the note is async, so this is
 * resolved alongside the pixel size rather than inside `buildMenu`.
 */
async function currentWidthOf(app: App, t: Target): Promise<number | null> {
  if (!t.noteFile || t.transcluded) return null;
  try {
    const text = await app.vault.read(t.noteFile);
    const found = findEmbed(text, t.linkText, t.occurrence);
    if (!found) return null;
    return found.kind === 'wiki'
      ? wikiWidthOf(found.ref.inner)
      : markdownWidthOf(found.ref.inner);
  } catch {
    return null;
  }
}

/** The width is one of the pipe parts after the path in a wiki embed. */
function wikiWidthOf(inner: string): number | null {
  const parts = inner.split('|');
  for (let i = 1; i < parts.length; i += 1) {
    const m = /^(\d+)(?:x\d+)?(?:px)?$/i.exec(parts[i].trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/** For a markdown image the width lives in the alt text, not the path. */
function markdownWidthOf(alt: string): number | null {
  const width = altParts(alt).width;
  if (!width) return null;
  return Number(width.split('x')[0]);
}

/**
 * Find the embed in the note's text that produced THIS picture.
 *
 * `occurrence` is which copy was clicked, counted among the embeds pointing at
 * the same file. Taking the first match instead would resize the wrong picture
 * in any note that uses one image twice, which is the ordinary case for a
 * divider or a logo.
 */
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
  const off = protectedRanges(text);
  const refs = scanImageRefs(text, (i) => isProtected(off, i));
  const external = isExternal(linkText);
  const ref = findRef(
    refs,
    (r) =>
      external
        ? isExternal(r.dest) && sameUrl(r.dest, linkText)
        : !isExternal(r.dest) && sameVaultPath(r.dest, linkText),
    occurrence,
  );
  return ref ? { start: ref.start, end: ref.end, inner: ref.inner, kind: ref.kind, ref } : null;
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

/**
 * Which copy of a bare markdown or external image was clicked. Wiki embeds are
 * counted separately, because their link text lives on the `.internal-embed`
 * wrapper rather than on the image itself.
 */
function occurrenceIn(
  el: HTMLImageElement,
  key: string,
): number {
  const scope = el.closest('.markdown-preview-view, .markdown-source-view') ?? el.ownerDocument;
  /* EVERY image in the note, both syntaxes together, in document order.
   *
   * The text side counts the two syntaxes in one sequence, so the DOM side has
   * to as well. Counting them separately means a note holding `![x](a.png)`
   * followed by `![[a.png]]` reports the wiki embed as copy 0, and the resize
   * lands on the markdown image above it.
   *
   * The comparison is by DESTINATION, never by the whole link text. The `src`
   * attribute carries the width too, so `![[a.png|100]]` and `![[a.png|200]]`
   * look like different pictures to a raw string compare and each reports
   * itself as copy 0, which sends the second one's resize to the first. */
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

/**
 * The note that owns this rendered element. A right-click in a background pane
 * must not resolve against whichever note happens to be focused, so the owning
 * markdown leaf is found by containment first.
 */
function noteFileForEl(app: App, el: HTMLElement): TFile | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    /* `file` lives on MarkdownView rather than the base View, and a leaf of
     * type markdown always carries one, so this narrows rather than casting
     * to `any`. A pane with no file yet answers null and the caller falls
     * through to the active file. */
    const view = leaf.view as MarkdownView;
    if (view.containerEl.contains(el)) return view.file ?? null;
  }
  return app.workspace.getActiveFile();
}

function targetFrom(app: App, ev: MouseEvent): Target | null {
  const node = ev.target as HTMLElement | null;
  /* A pop-out window's image belongs to another DOM, so `instanceof
   * HTMLImageElement` fails there even though the element is an image. The tag
   * name works across window boundaries. */
  if (!node || node.tagName !== 'IMG') return null;
  const el = node as HTMLImageElement;
  const noteFile = noteFileForEl(app, el);

  const embedEl = el.closest('.internal-embed') as HTMLElement | null;
  if (embedEl) {
    const linkText = embedEl.getAttribute('src');
    if (!linkText) return null;

    const file = app.metadataCache.getFirstLinkpathDest(
      partsOf(linkText).path,
      noteFile?.path ?? '',
    );
    if (!file) return null;

    /* Which copy is this? Count the embeds before it, in the same rendered
     * container, that name the same file. */
    const occurrence = occurrenceIn(el, partsOf(linkText).path);
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
    const occurrence = occurrenceIn(el, domKeyOf(el) ?? src);
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
    const occurrence = occurrenceIn(el, domKeyOf(el) ?? src);
    return { file, linkText, occurrence, noteFile, el, url: null, transcluded: isTranscluded(el) };
  }

  return null;
}

/**
 * Rewrite one note through the vault. The rewrite callback receives the
 * CURRENT text, so every offset it returns must be computed from that argument
 * and never from a snapshot read earlier. `vault.process` is the atomic
 * read-modify-write Obsidian provides; older builds fall back to
 * read-then-modify, where the lost-update window cannot be closed.
 */
async function updateNote(
  app: App,
  file: TFile,
  rewrite: (text: string) => string | null,
): Promise<boolean> {
  const vault = app.vault as unknown as ProcessVault;
  if (typeof vault.process === 'function') {
    let found = false;
    await vault.process(file, (text) => {
      const next = rewrite(text);
      if (next === null) return text;
      found = true;
      return next;
    });
    return found;
  }

  const text = await app.vault.read(file);
  const next = rewrite(text);
  if (next === null) return false;
  if (next === text) return true;
  await app.vault.modify(file, next);
  return true;
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

async function widthFor(app: App, t: Target, opt: SizeOption): Promise<number | null> {
  if (opt.px !== null) return opt.px;
  const natural = await sizeFor(app, t);
  if (!natural) {
    const name = t.file ? t.file.name : t.linkText;
    new Notice(
      `Could not read the size of "${name}", so a percentage cannot be worked out.`,
    );
    return null;
  }
  return Math.round((natural.w * (opt.percent ?? 100)) / 100);
}

async function copyImageToClipboard(app: App, file: TFile): Promise<void> {
  try {
    const bytes = await app.vault.readBinary(file);
    /* Everything goes to the clipboard as PNG. It is the one image type every
     * target accepts, and a JPEG blob labelled image/png is refused outright.
     * The canvas round trip is what performs the conversion. */
    const blob = new Blob([bytes], { type: `image/${file.extension.toLowerCase()}` });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
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
  const p = navigator.platform.toLowerCase();
  if (p.includes('mac')) return 'Show in Finder';
  if (p.includes('linux')) return 'Show in file manager';
  return 'Show in Explorer';
}

/**
 * Remove the reference from this note, then trash the file, but only when
 * trashing it is safe.
 *
 * ## What this refuses to do
 *
 * A picture is a file, and a file can be used by more than one note. The
 * obvious implementation removes the embed in front of you and trashes the
 * file, which silently breaks every OTHER note that used it. Worse, when the
 * reference cannot be found at all, the same implementation trashes the file
 * having removed nothing, so the user loses the picture and keeps the broken
 * link.
 *
 * So both are checked first. Obsidian already knows who links to what through
 * `metadataCache.resolvedLinks`, which is a map of source note to the targets
 * it references, so asking costs nothing.
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
  let renameError: string | null = null;
  void app.fileManager.renameFile(file, next).catch((err: unknown) => {
    renameError = err instanceof Error ? err.message : String(err);
  });

  const moved = await waitForPath(app, next, 3000);
  if (!moved) {
    if (renameError !== null) {
      new Notice(`Could not rename "${oldName}": ${renameError}`);
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

/** Build the menu for one picture. Exported so a test can read the row list. */
export function buildMenu(
  app: App,
  s: ImageToolSettings,
  t: Target,
  size: { w: number; h: number } | null,
  currentWidth: number | null,
  extras: ((menu: Menu, t: Target) => void)[],
): Menu {
  const menu = new Menu();
  const file = t.file;
  const full = file ? fullPathOf(app, file) : null;
  const desktop = app as unknown as DesktopApp;

  if (s.showFileInfo) {
    menu.addItem((i) => i.setTitle(file ? file.name : 'Remote image').setIsLabel(true));
    if (size) menu.addItem((i) => i.setTitle(`${size.w} x ${size.h} px`).setIsLabel(true));
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

  const sizes = parseSizes(s.customSizes);
  if (sizes.length) {
    menu.addSeparator();
    for (const opt of sizes) {
      menu.addItem((i) =>
        i.setTitle(opt.label).onClick(async () => {
          const w = await widthFor(app, t, opt);
          if (w !== null) await applyWidth(app, t, w);
        }),
      );
    }
    menu.addItem((i) =>
      i.setTitle('Resize to...').onClick(() => {
        new TextPromptModal(app, 'Resize', 'Width in pixels, or empty to clear it', '', (v) => {
          const raw = v.trim().replace(/px$/i, '');
          const n = Number(raw);
          void applyWidth(app, t, raw === '' ? null : Number.isFinite(n) && n > 0 ? n : null);
        }).open();
      }),
    );
  }
  if (currentWidth !== null) {
    menu.addItem((i) =>
      i.setTitle('Remove custom size').onClick(() => void applyWidth(app, t, null)),
    );
  }

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
          new ConfirmModal(
            app,
            'Delete image and link',
            `"${file.name}" will go to your configured trash, and the embed will be removed from this note.`,
            run,
          ).open();
        }),
    );
  }

  for (const add of extras) add(menu, t);
  return menu;
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

  /* ONE WRITE PER GESTURE, not one per notch. A wheel emits events far faster
   * than a vault write completes, so writing on each one queues dozens of
   * modifications of the same note, each re-rendering the view under the
   * pointer and each racing the next. The width is tracked in memory, the
   * picture is scaled live through its own style so the gesture still looks
   * immediate, and the note is written once the wheel stops. */
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

  const wire = (win: Window): void => {
    const onContextMenu = (ev: MouseEvent): void => {
      /* ONE MENU PER RIGHT-CLICK, whatever the window.
       *
       * Measured in a pop-out window: two identical menus opened, stacked,
       * for a single right-click, while the main window opened one. The
       * registration guard below cannot see that, because it dedupes by
       * Window object and the second delivery arrives with a reference that
       * does not match the key it was stored under.
       *
       * The event itself is the unique thing, so the guard belongs here. The
       * first delivery calls preventDefault, so a second delivery of the SAME
       * event leaves without building a menu. A fresh right-click arrives
       * undefaulted and is unaffected. */
      if (ev.defaultPrevented) return;
      const t = targetFrom(app, ev);
      if (!t) return;
      ev.preventDefault();
      const s = read();
      void Promise.all([sizeFor(app, t), currentWidthOf(app, t)]).then(([size, width]) => {
        buildMenu(app, s, t, size, width, extras).showAtMouseEvent(ev);
      });
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
      const t = targetFrom(app, ev as unknown as MouseEvent);
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
      win.removeEventListener('click', onClick);
      win.removeEventListener('wheel', onWheel);
    };

    const previous = windowCleanups.get(win);
    if (previous) previous();
    windowCleanups.set(win, cleanup);

    win.addEventListener('contextmenu', onContextMenu);
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
