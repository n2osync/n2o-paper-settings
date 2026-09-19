/**
 * The embed grammar, with no Obsidian in it.
 *
 * `![[cabin.png|plain aged|A cabin in the pines|300]]` carries four things in
 * one pair of brackets: a path, flag words, a caption, and Obsidian's own
 * width. Anything that edits one of them has to leave the other three alone,
 * which is the whole difficulty and is pure string work.
 *
 * Separated from the menu so it can be run without Obsidian present:
 * `node scripts/check-embed-flags.mjs`. picture-captions.ts says its parser is
 * "exported for its tests" and there were none, so this file is the first in
 * the repo that can actually fail.
 */
/** The words that are flags and not caption text. The vocabulary lives with
 *  the grammar, so nothing that parses an embed has to import Obsidian to
 *  learn it, and there is one list rather than two to drift apart. */
export const FLAGS = new Set(['left', 'right', 'round', 'aged', 'seamless', 'torn', 'plain']);

/** Obsidian's own trailing size part, which is a number and never a caption. */
const isWidth = (part: string) => /^\d+(x\d+)?$/.test(part.trim());

export interface Embed {
  /** Character offset of `![[` on the line. */
  start: number;
  /** Character offset just past `]]`. */
  end: number;
  /** Everything between the brackets. */
  inner: string;
}

/**
 * The embed the cursor sits in, or null.
 *
 * A line can hold several pictures, so this returns the one the cursor is
 * actually inside rather than the first it finds. Exported for its tests.
 */
export function embedAt(line: string, ch: number): Embed | null {
  const re = /!\[\[([^\]]*)\]\]/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const start = m.index;
    const end = start + m[0].length;
    if (ch >= start && ch <= end) return { start, end, inner: m[1] };
  }
  return null;
}

/** Split an embed's inner text into the four things it can carry. */
export function partsOf(inner: string): {
  path: string;
  flags: string[];
  caption: string | null;
  width: string | null;
} {
  const [path, ...rest] = inner.split('|');
  const flags: string[] = [];
  const other: string[] = [];
  let width: string | null = null;

  for (const part of rest) {
    const t = part.trim();
    if (!t) continue;
    if (isWidth(t)) { width = t; continue; }
    /* Same test the caption parser uses: a part is a flag part only when
     * EVERY word in it is a flag, so a caption reading "the left bank" is a
     * caption and not a float instruction. */
    const words = t.split(/\s+/);
    if (words.every((w) => FLAGS.has(w.toLowerCase()))) flags.push(...words.map((w) => w.toLowerCase()));
    else other.push(t);
  }
  return { path, flags, caption: other.length ? other.join(' ') : null, width };
}

/** Reassemble, dropping anything empty so no stray pipes are left behind. */
export function buildEmbed(p: {
  path: string;
  flags: string[];
  caption: string | null;
  width: string | null;
}): string {
  const parts = [p.path];
  if (p.flags.length) parts.push(p.flags.join(' '));
  if (p.caption) parts.push(p.caption);
  if (p.width) parts.push(p.width);
  return `![[${parts.join('|')}]]`;
}

/** Add the flag if absent, remove it if present. Pure, and tested. */
export function toggleFlag(inner: string, flag: string): string {
  const p = partsOf(inner);
  const has = p.flags.includes(flag);
  let flags = has ? p.flags.filter((f) => f !== flag) : [...p.flags, flag];
  /* left and right are the same decision, so picking one drops the other
   * rather than leaving a picture asked to float both ways. */
  if (!has && (flag === 'left' || flag === 'right')) {
    const opposite = flag === 'left' ? 'right' : 'left';
    flags = flags.filter((f) => f !== opposite);
  }
  return buildEmbed({ ...p, flags });
}

/** Replace the caption, or clear it when given an empty string. */
export function withCaption(inner: string, caption: string): string {
  const p = partsOf(inner);
  return buildEmbed({ ...p, caption: caption.trim() || null });
}
