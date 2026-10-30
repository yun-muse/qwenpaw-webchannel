/**
 * M36 — LaTeX math delimiters, as pure logic plus the two `marked` extensions.
 *
 * The delimiters are scanned here, never inside KaTeX: the library only ever
 * sees a substring that already had both delimiters matched. That keeps
 * half-finished streaming text (`$$` opened, not yet closed) as plain text and
 * keeps every error boundary in our code, not inside a renderer.
 *
 * Pairing rules (also the unit-test contract):
 *   R1  A `$` escaped as `\$` is literal and can neither open nor close math.
 *   R2  An inline opener is a single `$` (not part of `$$`) and must be
 *       followed by a non-space character; the closer must not be preceded by
 *       whitespace. `$ ... $` (spaces just inside) is therefore not math.
 *   R3  Inline math lives on one line; a newline before the closer cancels it.
 *   R4  Currency guard: the closer must not be followed by a digit. This is
 *       what keeps `$5 and $10` plain — the only candidate closer sits right
 *       before `10`, so it is rejected and the opening `$` never pairs.
 *   R5  No closer -> plain text. No exception is thrown, ever.
 *   R6  `$$...$$` is display math when it starts a line (up to 3 spaces of
 *       indent) and is followed only by spaces/EOL after the closer; it may
 *       span lines. Unclosed -> plain text.
 *   R7  Fenced code blocks and inline code spans are opaque. `marked` already
 *       tokenises them before our inline extension runs; `scanMath` below
 *       mirrors that for the tests and for documentation.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCK_OPEN = /^ {0,3}\$\$/;

export interface MathSpan {
  /** Index of the first delimiter character. */
  start: number;
  /** Index just past the closing delimiter. */
  end: number;
  /** Inner LaTeX, trimmed for display math. */
  tex: string;
  display: boolean;
}

function isEscaped(src: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * `src[start]` is a single `$` (not `$$`). Returns the first valid match, or
 * `null` when this `$` cannot open inline math. The first unescaped `$` that
 * follows is always treated as the candidate closer: if it fails R2/R4 the
 * opener is rejected outright, so a currency `$10` can never close a formula
 * opened by an unrelated `$5`.
 */
export function readInlineMath(src: string, start = 0): MathSpan | null {
  if (src[start] !== '$' || src[start + 1] === '$') return null;
  if (isEscaped(src, start)) return null;
  const first = src[start + 1];
  if (!first || /\s/.test(first)) return null;

  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n') return null;
    if (ch !== '$') continue;
    const tex = src.slice(start + 1, i);
    if (tex.length === 0 || /\s$/.test(tex)) return null;
    const after = src[i + 1] ?? '';
    if (/\d/.test(after)) return null;
    return { start, end: i + 1, tex, display: false };
  }
  return null;
}

/**
 * `src[start..start+2]` is `$$`. Display math may span lines. An escaped `\$`
 * inside is skipped, and an empty body is not math.
 */
export function readDisplayMath(src: string, start = 0): MathSpan | null {
  if (src[start] !== '$' || src[start + 1] !== '$') return null;
  if (isEscaped(src, start)) return null;
  for (let i = start + 2; i < src.length - 1; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] !== '$' || src[i + 1] !== '$') continue;
    const tex = src.slice(start + 2, i).trim();
    if (tex.length === 0) return null;
    return { start, end: i + 2, tex, display: true };
  }
  return null;
}

/** Index of the next backtick run of exactly `length`, or -1. */
function findBacktickRun(src: string, from: number, length: number): number {
  for (let i = from; i < src.length; i += 1) {
    if (src[i] !== '`') continue;
    let run = 0;
    while (src[i + run] === '`') run += 1;
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

/**
 * Whole-document scanner used by the unit tests and as the readable statement
 * of the rules. Production rendering goes through the `marked` extensions
 * below, which call the same `readInlineMath` / `readDisplayMath` functions —
 * the code exemption there is structural (`marked` tokenises fences and code
 * spans first), while here it is explicit.
 */
export function scanMath(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = 0;
  let lineStart = true;

  while (i < text.length) {
    if (lineStart) {
      const fence = FENCE.exec(text.slice(i));
      if (fence) {
        const marker = fence[1][0];
        const length = fence[1].length;
        let cursor = i + fence[0].length;
        while (cursor < text.length) {
          const nl = text.indexOf('\n', cursor);
          if (nl < 0) {
            cursor = text.length;
            break;
          }
          const nextStart = nl + 1;
          const nextEnd = text.indexOf('\n', nextStart);
          const line = text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd);
          const closing = CLOSING_FENCE.exec(line);
          cursor = nextEnd < 0 ? text.length : nextEnd;
          if (closing && closing[1][0] === marker && closing[1].length >= length) {
            cursor = nextEnd < 0 ? text.length : nextEnd + 1;
            break;
          }
        }
        i = cursor;
        lineStart = true;
        continue;
      }

      let indent = 0;
      while (indent < 3 && text[i + indent] === ' ') indent += 1;
      if (BLOCK_OPEN.test(text.slice(i, i + indent + 2))) {
        const block = readDisplayMath(text, i + indent);
        if (block && /^[ \t]*(?:\n|$)/.test(text.slice(block.end))) {
          spans.push(block);
          const nl = text.indexOf('\n', block.end);
          i = nl < 0 ? text.length : nl + 1;
          lineStart = true;
          continue;
        }
      }
    }

    const ch = text[i];
    if (ch === '\n') {
      i += 1;
      lineStart = true;
      continue;
    }
    lineStart = false;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (text[i + run] === '`') run += 1;
      const close = findBacktickRun(text, i + run, run);
      i = close < 0 ? i + run : close + run;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const display = readDisplayMath(text, i);
        if (display) {
          spans.push(display);
          i = display.end;
          continue;
        }
        i += 2;
        continue;
      }
      const inline = readInlineMath(text, i);
      if (inline) {
        spans.push(inline);
        i = inline.end;
        continue;
      }
    }
    i += 1;
  }
  return spans;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Placeholder markup. Until KaTeX loads (and forever, if the chunk never
 * loads) the element contains the literal `$...$` source, so the fallback is
 * readable rather than blank. `data-tex` carries the source for hydration and
 * for click-to-copy.
 */
export function mathHtml(tex: string, display: boolean): string {
  const cls = display ? 'math math-block' : 'math math-inline';
  const source = display ? `$$${tex}$$` : `$${tex}$`;
  return (
    `<span class="${cls}" data-tex="${escapeHtml(tex)}" data-math-state="pending" role="math">` +
    `${escapeHtml(source)}</span>`
  );
}

/**
 * `marked` extensions. Both levels are needed: a `$$` block on its own lines
 * becomes a block token (so M32 freezes it as one unit), while `$$...$$` and
 * `$...$` inside a paragraph or table cell are inline tokens.
 */
export const mathExtensions = [
  {
    name: 'mathBlock',
    level: 'block' as const,
    start(src: string) {
      const at = src.indexOf('$$');
      return at < 0 ? undefined : at;
    },
    tokenizer(src: string) {
      if (!BLOCK_OPEN.test(src)) return undefined;
      const match = /^ {0,3}\$\$([ \t]*\r?\n)?([\s\S]*?)(\r?\n)?\$\$[ \t]*(?=\n|$)/.exec(src);
      if (!match) return undefined;
      const tex = match[2].trim();
      // `$$a$$ and $$b$$` is not one block; leave it to the inline tokenizer.
      if (tex.length === 0 || tex.includes('$$')) return undefined;
      return { type: 'mathBlock', raw: match[0], tex, display: true };
    },
    renderer(token: { tex?: string }) {
      return mathHtml(String(token.tex ?? ''), true);
    },
  },
  {
    name: 'mathInline',
    level: 'inline' as const,
    start(src: string) {
      return src.indexOf('$') < 0 ? undefined : src.indexOf('$');
    },
    tokenizer(src: string) {
      if (src[0] !== '$') return undefined;
      if (src[1] === '$') {
        const display = readDisplayMath(src, 0);
        if (!display) return undefined;
        return {
          type: 'mathInline',
          raw: src.slice(0, display.end),
          tex: display.tex,
          display: true,
        };
      }
      const inline = readInlineMath(src, 0);
      if (!inline) return undefined;
      return {
        type: 'mathInline',
        raw: src.slice(0, inline.end),
        tex: inline.tex,
        display: false,
      };
    },
    renderer(token: { tex?: string; display?: boolean }) {
      return mathHtml(String(token.tex ?? ''), Boolean(token.display));
    },
  },
];
