/**
 * A picture can carry flags and a caption, separated by pipes:
 *
 *     ![[cabin.png|aged|A cabin in the pines|300]]
 *
 * Obsidian renders that with alt "aged|A cabin in the pines" and width 300.
 * The theme draws the caption from an attribute and matches flags on `alt`,
 * and CSS cannot split one attribute, so this post-processor writes:
 *
 *   - the wrapper's `alt`: the flags alone, which the theme's flag rules match;
 *   - `data-n2o-caption`: the caption, which the theme draws;
 *   - the inner image's `alt`: the caption, as the accessible name.
 *
 * An alt with no pipe is left as it is.
 */
import { FLAGS } from './embed-flags';
import { MarkdownRenderChild } from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';

/**
 * The words the theme reads as switches. In step with
 * `src/css/48-embed-flags.css` and `48d-aged-photos.css`; a word missing here
 * is a word that ends up printed as part of a caption.
 */

/** A bare file name is not a caption. The same list the theme's rule excludes. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export interface ParsedAlt {
  /** The flag words, in the order written, ready to be an `alt`. */
  flags: string[];
  /** What the reader should see on the foot of the print. Never null: a parse
   * with no caption returns null for the whole result instead. */
  caption: string;
}

/**
 * Split an alt into flags and caption. Returns null when there is nothing to
 * do, which is the common case and means "leave this picture alone".
 *
 * Pure, and exported for its tests: this is the whole of the decision.
 */
export function parseAlt(alt: string | null | undefined): ParsedAlt | null {
  if (!alt || !alt.includes('|')) return null;

  const parts = alt.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const flags: string[] = [];
  const rest: string[] = [];
  for (const part of parts) {
    const words = part.split(/\s+/);
    if (words.every((w) => FLAGS.has(w.toLowerCase()))) flags.push(...words.map((w) => w.toLowerCase()));
    else rest.push(part);
  }

  // No flag: the theme captions it from the alt on its own.
  if (!flags.length) return null;

  const caption = rest.find((r) => !IMAGE_FILE.test(r)) ?? null;
  if (!caption) return null;
  return { flags, caption };
}

/** Stamp every picture in a rendered chunk. Idempotent: a rewritten alt has no pipe. */
export function markCaptions(root: HTMLElement): void {
  root.querySelectorAll('.image-embed').forEach((el) => {
    const parsed = parseAlt(el.getAttribute('alt'));
    if (!parsed) return;

    /* A round print has no frame, so it has no foot to write on and the theme
     * captions none of them. The flags still apply. */
    const round = parsed.flags.includes('round');
    el.setAttribute('alt', parsed.flags.join(' '));
    if (round) el.removeAttribute('data-n2o-caption');
    else el.setAttribute('data-n2o-caption', parsed.caption);

    const img = el.querySelector('img');
    if (img) img.setAttribute('alt', parsed.caption);
  });
}

/**
 * Stamp each rendered chunk now and again as Obsidian resolves its embeds,
 * which happens after the post-processor returns. The observer ends with the
 * chunk. It cannot loop: a rewritten alt has no pipe.
 */
export function registerPictureCaptions(
  register: (fn: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void,
): void {
  register((el, ctx) => {
    markCaptions(el);
    const child = new MarkdownRenderChild(el);
    const observer = new MutationObserver(() => markCaptions(el));
    child.register(() => observer.disconnect());
    // Obsidian marks an embed resolved by changing its class, not by adding a node.
    observer.observe(el, { childList: true, subtree: true, attributeFilter: ['alt', 'class', 'src'] });
    ctx.addChild(child);
  });
}
