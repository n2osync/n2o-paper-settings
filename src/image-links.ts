/**
 * Finding and rewriting the two ways a picture can be written, plus the third
 * way that is not in the vault at all.
 *
 * ## Why this is not just a wikilink regex
 *
 * Obsidian accepts both syntaxes for the same picture and people use both:
 *
 *   ![[cabin.png|500]]            the wiki embed, what Obsidian writes itself
 *   ![a cabin|500](cabin.png)     the markdown image, what a paste from
 *                                 anywhere else produces
 *   ![a cabin|500](https://...)   the same, pointing outside the vault
 *
 * The width lives in a different place in each. In a wiki embed it is a pipe
 * part of the link. In a markdown image it is a pipe part of the ALT TEXT,
 * which is the part before the parenthesis, because the destination has to
 * stay a usable path. A menu that only understood the first would silently do
 * nothing on half the pictures in a vault that has ever had something pasted
 * into it.
 *
 * External pictures have no `TFile`, so they are matched by URL rather than by
 * file. They can still be resized, which is the only operation that makes
 * sense for a file we do not own.
 */

export type RefKind = 'wiki' | 'markdown';

export interface ImageRef {
  kind: RefKind;
  /** Offsets of the WHOLE reference in the note text. */
  start: number;
  end: number;
  /** wiki: everything inside `[[ ]]`. markdown: the alt text. */
  inner: string;
  /** Where it points: a vault path for wiki and local markdown, else a URL. */
  dest: string;
  /** markdown: set when the original destination used angle brackets. */
  destBracketed?: boolean;
}

/** A vault path or URL, compared without caring about case or `./` noise. */
export function normalizeDest(value: string): string {
  let v = value.trim();
  /* Obsidian writes a markdown destination percent-encoded, so `my pic.png`
   * arrives as `my%20pic.png` and would never match the file name. */
  try {
    v = decodeURIComponent(v);
  } catch {
    /* A stray percent sign is not an encoding error worth failing over; the
     * raw text is still a usable comparison key. */
  }
  v = v.replace(/^\.\//, '');
  /* A markdown destination may carry a title: ![a](pic.png "Title") */
  v = v.replace(/\s+"[^"]*"$/, '').replace(/\s+'[^']*'$/, '');
  /* A wiki path may carry a heading or block ref, which is not part of it. */
  v = v.replace(/[#^][^|]*$/, '');
  return v.toLowerCase();
}

/** True when two destinations name the same vault file. */
export function sameVaultPath(a: string, b: string): boolean {
  const x = normalizeDest(a);
  const y = normalizeDest(b);
  if (x === y) return true;
  /* One side may be a full subpath and the other a bare name. The slash keeps
   * `cabin.png` from matching `log-cabin.png`. */
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** True when two URLs are the same picture, ignoring protocol and query noise. */
export function sameUrl(a: string, b: string): boolean {
  const strip = (u: string): string =>
    u
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return strip(a) === strip(b);
}

/** True when a destination points outside the vault. */
export function isExternal(dest: string): boolean {
  return /^(https?:|data:)/i.test(dest.trim());
}

interface MarkdownDest {
  dest: string;
  end: number;
  bracketed: boolean;
}

/** Index of the link-closing `)`, ignoring parentheses inside a quoted title. */
function readMarkdownClose(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ')') return i;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      if (i >= text.length) return -1;
    }
  }
  return -1;
}

/**
 * The markdown destination that begins at `open`, the index of `(`.
 * Angle brackets are dropped here but remembered so a rewrite can restore
 * them; a bare destination is read with a paren depth so the link closes at
 * the right `)`.
 */
function readMarkdownDest(text: string, open: number): MarkdownDest | null {
  const start = open + 1;
  if (text[start] === '<') {
    const gt = text.indexOf('>', start + 1);
    if (gt === -1) return null;
    const close = readMarkdownClose(text, gt + 1);
    if (close === -1) return null;
    return {
      dest: text.slice(start + 1, gt) + text.slice(gt + 1, close),
      end: close + 1,
      bracketed: true,
    };
  }

  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      if (depth === 0) {
        return { dest: text.slice(start, i), end: i + 1, bracketed: false };
      }
      depth -= 1;
    } else if (depth === 0 && /\s/.test(ch)) {
      /* A space at depth zero ends a bare destination; the rest is a title. */
      const close = readMarkdownClose(text, i);
      if (close === -1) return null;
      return { dest: text.slice(start, close), end: close + 1, bracketed: false };
    }
  }
  return null;
}

/**
 * Every image reference in the note, in document order.
 *
 * `skip` is the protected-range test, so examples inside code fences are never
 * returned and therefore can never be rewritten.
 */
export function scanImageRefs(text: string, skip: (index: number) => boolean): ImageRef[] {
  const out: ImageRef[] = [];

  const wiki = /!\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(text))) {
    if (skip(m.index)) continue;
    const dest = m[1].split('|')[0];
    out.push({ kind: 'wiki', start: m.index, end: m.index + m[0].length, inner: m[1], dest });
  }

  /* Markdown is scanned by hand because a destination may contain balanced
   * parens, which a regex would close at the first `)`, and may be wrapped in
   * angle brackets, which are delimiters rather than part of the path. */
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '!' || text[i + 1] !== '[') {
      i += 1;
      continue;
    }
    const altEnd = text.indexOf(']', i + 2);
    if (altEnd === -1) break;
    const open = altEnd + 1;
    if (text[open] !== '(') {
      i = altEnd + 1;
      continue;
    }
    const parsed = readMarkdownDest(text, open);
    if (!parsed) {
      i = altEnd + 1;
      continue;
    }
    if (!skip(i)) {
      out.push({
        kind: 'markdown',
        start: i,
        end: parsed.end,
        inner: text.slice(i + 2, altEnd),
        dest: parsed.dest,
        destBracketed: parsed.bracketed,
      });
    }
    i = parsed.end;
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Split a markdown alt text into its caption and its width. */
export function altParts(alt: string): { caption: string; width: string | null } {
  const bits = alt.split('|');
  if (bits.length === 1) return { caption: alt, width: null };
  const last = bits[bits.length - 1].trim();
  const m = /^(\d+)(?:x(\d+))?(?:px)?$/.exec(last);
  if (m) {
    return {
      caption: bits.slice(0, -1).join('|'),
      width: m[2] ? `${m[1]}x${m[2]}` : m[1],
    };
  }
  return { caption: alt, width: null };
}

/** Put angle brackets back around a markdown destination that had them. */
function formatMarkdownDest(dest: string, bracketed: boolean | undefined): string {
  if (!bracketed) return dest;
  /* A title sits outside the angle brackets, so only the path part is wrapped. */
  const titled = /^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/.exec(dest);
  if (titled) {
    const path = titled[1] ?? '';
    const title = titled[2] ?? '';
    return `<${path}>${title}`;
  }
  return `<${dest}>`;
}

/**
 * The whole reference rewritten with a new width, or with none when null.
 *
 * Each syntax keeps its own shape: the wiki embed gets a pipe part on the
 * link, the markdown image gets one on the alt text, and the destination text
 * is never touched in either. Angle brackets around a markdown destination
 * are put back when the original had them.
 */
export function refWithWidth(
  ref: ImageRef,
  width: number | null,
  wikiRewrite: (inner: string, width: number | null) => string,
): string {
  /* `wikiRewrite` is `withWidth`, which returns the WHOLE embed rather than
   * its inner text, so this passes it straight through. Wrapping it again in
   * brackets is the obvious mistake and produces `![[![[cabin.png|500]]]]`. */
  if (ref.kind === 'wiki') return wikiRewrite(ref.inner, width);
  const { caption } = altParts(ref.inner);
  const alt = width && width > 0 ? `${caption}|${Math.round(width)}` : caption;
  return `![${alt}](${formatMarkdownDest(ref.dest, ref.destBracketed)})`;
}

/**
 * The reference that produced a given picture, by occurrence.
 *
 * `occurrence` counts only references that match, so the second copy of one
 * picture in a note is reachable without touching the first.
 */
export function findRef(
  refs: ImageRef[],
  matches: (ref: ImageRef) => boolean,
  occurrence: number,
): ImageRef | null {
  let seen = 0;
  for (const ref of refs) {
    if (!matches(ref)) continue;
    if (seen === occurrence) return ref;
    seen += 1;
  }
  return null;
}
