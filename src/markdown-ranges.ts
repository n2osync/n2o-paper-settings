/**
 * Which parts of a note are CODE, and therefore must never be rewritten.
 *
 * ## The scenario
 *
 * Someone writes a note about how the theme works. In it, inside a fenced
 * block, they show the syntax:
 *
 * ```
 * ![[cabin.png|plain|A cabin]]
 * ```
 *
 * They then right-click a real picture further down and resize it. A rewrite
 * that searches the note for the first matching embed edits the EXAMPLE, in a
 * code block, silently, and the real picture does not change. Documentation
 * about the feature is exactly the text most likely to contain an embed that
 * is not an embed.
 *
 * So every rewrite asks this module which ranges are off limits first.
 *
 * ## The honest limit
 *
 * This covers fenced blocks, including ones opened inside a blockquote or a
 * list item, inline code spans and YAML frontmatter, which is what actually
 * appears in notes. It does NOT cover indented code blocks, the four-space
 * kind, because telling an indented code block apart from a nested list
 * continuation needs a real block parser: the same four spaces mean code
 * after a blank line and mean list content after a bullet. Pixel Perfect Image
 * spends 251 lines getting that right and tracks list content indent, setext
 * headings and blockquote prefixes to do it. If an embed inside an indented
 * code block ever gets rewritten, that is the gap, and the fix is a real
 * parser rather than another regex.
 */

export interface TextRange {
  start: number;
  end: number;
}

/** True when the character at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes += 1;
  return slashes % 2 === 1;
}

function lineEnd(text: string, start: number): number {
  const nl = text.indexOf('\n', start);
  return nl < 0 ? text.length : nl;
}

function sliceLine(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/\r$/, '');
}

function nextLineStart(text: string, end: number): number | null {
  return end < text.length ? end + 1 : null;
}

/** A line whose only content is a frontmatter delimiter. */
function isFrontmatterDelimiter(line: string): boolean {
  return /^---$/.test(line);
}

/**
 * YAML frontmatter, when the note opens with it.
 *
 * The opening `---` must be the very first line. A `---` followed by a blank
 * line is a thematic break, not frontmatter, and an unclosed `---` or one
 * with nothing before its closing delimiter is not frontmatter either.
 * Treating any of those as frontmatter would protect the whole note and
 * quietly stop every rewrite.
 */
function frontmatterRange(text: string): TextRange | null {
  const firstEnd = lineEnd(text, 0);
  if (!isFrontmatterDelimiter(sliceLine(text, 0, firstEnd))) return null;

  const afterOpening = nextLineStart(text, firstEnd);
  if (afterOpening === null) return null;

  let lineStart = afterOpening;
  let hasContent = false;

  while (lineStart < text.length) {
    const end = lineEnd(text, lineStart);
    const line = sliceLine(text, lineStart, end);

    if (isFrontmatterDelimiter(line)) {
      if (!hasContent) return null;
      return { start: 0, end: end < text.length ? end + 1 : end };
    }

    /* A blank line right after the opening delimiter makes it a thematic
     * break, so the rest of the note must stay visible. */
    if (!hasContent && line.trim() === '') return null;
    hasContent = true;

    const next = nextLineStart(text, end);
    if (next === null) break;
    lineStart = next;
  }

  return null;
}

interface FenceDelimiter {
  marker: string;
  length: number;
  info: string;
  indent: number;
}

type Container =
  | { kind: 'quote'; markers: number }
  | { kind: 'list'; indent: number };

/* A blockquote marker may be indented up to three spaces and may carry one
 * optional space or tab after the `>`. */
const quoteMarker = /^ {0,3}>[ \t]?/;

/* A list item marker may be indented up to three spaces and carries 1-4
 * spaces of padding. Together they fix the content indent for the rest of
 * the item. */
const listMarker = /^( {0,3})([-+*]|\d{1,9}[.)])( {1,4}|$)/;

function stripQuoteMarker(text: string): string | null {
  const m = quoteMarker.exec(text);
  return m ? text.slice(m[0].length) : null;
}

function stripListMarker(text: string): { rest: string; indent: number } | null {
  const m = listMarker.exec(text);
  if (!m) return null;
  return { rest: text.slice(m[0].length), indent: m[1].length + m[2].length + m[3].length };
}

function parseContainers(line: string): { containers: Container[]; rest: string } {
  const containers: Container[] = [];
  let rest = line;

  while (true) {
    let quoteCount = 0;
    while (true) {
      const after = stripQuoteMarker(rest);
      if (after === null) break;
      rest = after;
      quoteCount += 1;
    }
    if (quoteCount > 0) {
      containers.push({ kind: 'quote', markers: quoteCount });
      continue;
    }

    const list = stripListMarker(rest);
    if (list) {
      containers.push({ kind: 'list', indent: list.indent });
      rest = list.rest;
      continue;
    }

    break;
  }

  return { containers, rest };
}

function stripContainers(line: string, containers: Container[]): string | null {
  let rest = line;
  for (const container of containers) {
    if (container.kind === 'quote') {
      for (let i = 0; i < container.markers; i += 1) {
        const after = stripQuoteMarker(rest);
        if (after === null) return null;
        rest = after;
      }
    } else {
      if (rest.length < container.indent) return null;
      for (let i = 0; i < container.indent; i += 1) {
        if (rest[i] !== ' ') return null;
      }
      rest = rest.slice(container.indent);
    }
  }
  return rest;
}

/** The delimiter at the start of `text`, if it opens or closes a fence. */
function fenceDelimiterAt(text: string): FenceDelimiter | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
  if (!m) return null;
  const marker = m[2][0];
  /* A backtick fence's info string cannot contain a backtick, which is what
   * keeps an inline span like `` `a` `` from reading as a fence. */
  if (marker === '`' && m[3].includes('`')) return null;
  return { marker, length: m[2].length, info: m[3], indent: m[1].length };
}

interface OpeningFence {
  marker: string;
  length: number;
  indent: number;
  containers: Container[];
}

function openingFence(line: string): OpeningFence | null {
  const parsed = parseContainers(line);
  const delimiter = fenceDelimiterAt(parsed.rest);
  if (!delimiter) return null;
  return {
    marker: delimiter.marker,
    length: delimiter.length,
    indent: delimiter.indent,
    containers: parsed.containers,
  };
}

interface OpenFence {
  marker: string;
  length: number;
  indent: number;
  containers: Container[];
  start: number;
}

function closesFence(line: string, fence: OpenFence): boolean {
  const rest = stripContainers(line, fence.containers);
  if (rest === null) return false;

  const delimiter = fenceDelimiterAt(rest);
  if (!delimiter) return false;

  /* A closer keeps the marker, is at least as long, has no info string, and
   * may sit only a little further in than the opener it matches. */
  return (
    delimiter.marker === fence.marker &&
    delimiter.length >= fence.length &&
    delimiter.info.trim() === '' &&
    delimiter.indent <= fence.indent + 3
  );
}

/** Same-line backtick spans, matching run length so ``a ` b`` closes correctly. */
function collectInlineCode(line: string, lineStart: number, out: TextRange[]): void {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`' || isEscaped(line, i)) continue;
    let run = 1;
    while (line[i + run] === '`') run += 1;

    let search = i + run;
    let closed = false;
    while (search < line.length) {
      const at = line.indexOf('`', search);
      if (at < 0) break;
      let atRun = 1;
      while (line[at + atRun] === '`') atRun += 1;
      if (!isEscaped(line, at) && atRun === run) {
        const end = at + atRun;
        out.push({ start: lineStart + i, end: lineStart + end });
        i = end - 1;
        closed = true;
        break;
      }
      search = at + atRun;
    }
    /* An unclosed run is ordinary text, so skip past it rather than treating
     * the rest of the line as code. */
    if (!closed) i += run - 1;
  }
}

/**
 * Every range a rewrite must leave alone, in document order.
 *
 * An unclosed fence runs to the end of the note, which is what the renderer
 * does with it too.
 */
export function protectedRanges(text: string): TextRange[] {
  const out: TextRange[] = [];
  const fm = frontmatterRange(text);
  if (fm) out.push(fm);

  const from = fm ? fm.end : 0;
  let lineStart = from;
  let fence: OpenFence | null = null;

  while (lineStart <= text.length) {
    const end = lineEnd(text, lineStart);
    const line = sliceLine(text, lineStart, end);

    if (fence) {
      if (closesFence(line, fence)) {
        out.push({ start: fence.start, end });
        fence = null;
      }
    } else {
      const opening = openingFence(line);
      if (opening) {
        fence = {
          marker: opening.marker,
          length: opening.length,
          indent: opening.indent,
          containers: opening.containers,
          start: lineStart,
        };
      } else {
        collectInlineCode(line, lineStart, out);
      }
    }

    const next = nextLineStart(text, end);
    if (next === null) break;
    lineStart = next;
  }

  if (fence) out.push({ start: fence.start, end: text.length });
  return out;
}

/** True when `index` falls inside any protected range. */
export function isProtected(ranges: TextRange[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}
