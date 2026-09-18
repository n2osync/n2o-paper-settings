/**
 * A picture can carry flags AND a caption, separated by a pipe.
 *
 *     ![[cabin.png|aged|A cabin in the pines|300]]
 *
 * ## The scenario
 *
 * You float a photo into the margin and want it captioned, or you age one print
 * and want to say what it is. Without this you get one or the other: the theme
 * draws the caption with `content: attr(alt)` and has to exclude any alt
 * carrying a flag word, because otherwise the word `aged` would be written
 * across the foot of the print. CSS cannot take a substring of an attribute, so
 * the theme cannot separate the two on its own.
 *
 * ## Why a pipe, and not a space
 *
 * The first version of this split on whitespace and treated any flag word it
 * found as a flag. That is ambiguous and it eats real words: a photo captioned
 * "The left bank of the Seine" would have been floated into the margin and
 * captioned "The bank of the Seine".
 *
 * A pipe is unambiguous, and it is already Obsidian's own separator. Measured
 * rather than assumed, one case at a time:
 *
 *     ![[a.png|aged|A cabin in the pines|300]]  ->  alt "aged|A cabin in the pines", width 300
 *     ![[a.png|left|The left bank|300]]         ->  alt "left|The left bank",        width 300
 *
 * Obsidian passes the extra pipe through untouched and still reads the width
 * off the end, so nothing had to be invented.
 *
 * ## What it writes, and why each one
 *
 * Three attributes, because three different readers need three different things:
 *
 *   - the WRAPPER's `alt` becomes the flags alone, because that is what the
 *     theme's flag rules match on (`.image-embed[alt~="aged"]`), and they must
 *     keep working untouched.
 *   - `data-n2o-caption` carries the caption, which the theme draws on the foot
 *     of the print.
 *   - the inner `img`'s `alt` becomes the CAPTION, because that one is a real
 *     accessible name that a screen reader announces. Leaving `aged` there
 *     would read out a styling instruction as if it described the picture.
 *
 * ## It only ever ADDS
 *
 * An alt with no pipe is left exactly as it is, so every picture that works
 * today keeps working, with or without this plugin installed.
 */
import { MarkdownRenderChild } from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';

/**
 * The words the theme reads as switches. In step with
 * `src/css/48-embed-flags.css` and `48d-aged-photos.css`; a word missing here
 * is a word that ends up printed as part of a caption.
 */
const FLAGS = new Set(['left', 'right', 'round', 'aged', 'seamless', 'torn']);

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

  /* No flag means the theme already captions it from the alt, and doing the
   * same job twice is how two paths drift apart later. */
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
 * Wire it to Obsidian.
 *
 * A post processor alone is not enough, and this cost a round of "why is
 * nothing happening": Obsidian resolves an image embed AFTER the processor
 * returns, so at the moment it runs there is no `.image-embed` in the chunk to
 * stamp. The first pass catches anything already there, and an observer
 * catches the embeds as they arrive.
 *
 * Watching, rather than sleeping a guessed number of milliseconds and hoping
 * the embed beat the clock. It ends with the chunk: the render child owns the
 * observer and disconnects it on unload.
 *
 * It cannot loop. `markCaptions` rewrites an alt into one with no pipe, so the
 * mutation it causes parses to null on the next pass and changes nothing.
 */
export function registerPictureCaptions(
  register: (fn: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void,
): void {
  register((el, ctx) => {
    markCaptions(el);
    const child = new MarkdownRenderChild(el);
    const observer = new MutationObserver(() => markCaptions(el));
    child.register(() => observer.disconnect());
    /* `class` and `src` as well as `alt`. Obsidian marks an embed resolved by
     * changing its CLASS, and an observer watching `alt` alone never fired:
     * the element that eventually carries `.image-embed` was already in the
     * tree, so no childList mutation announced it either. */
    observer.observe(el, { childList: true, subtree: true, attributeFilter: ['alt', 'class', 'src'] });
    ctx.addChild(child);
  });
}
